var BinaryFile = require('../binary_file')
  , Remote = require('./remote')
  , Pack = require('./pack')
  , PackIndex = require('./pack_index')
  , utils = require('./utils')
  , _ = require('underscore')
  , inflate = require('./zlib').inflate
  , Objects = require('./objects')
  , http = require('./http')

var HttpRemote = function(repo, name, repoUrl) {
  Remote.call(this, repo, name, repoUrl)
}
HttpRemote.prototype = new Remote('','','')

HttpRemote.prototype.fetchRefs = function(callback) {
  var remote = this
  http.get(
    this.makeUri('/info/refs'),
    function(err, data) {
      var refs = HttpRemote.parseInfoRefs(data)
      _(refs).each(function(ref) {
        remote.addRef(ref.name, ref.sha)
      })
      if (callback !== undefined) {
        callback(null, refs)
      }
    }
  )
}

/**
 * Find all the names in the HttpRemote. Returns an array of {name, sha} in
 * the same order as names originally was.
 *
 * Ambiguous names (prefixes of multiple shas) cause an error. Names that
 * can't be found are returned as {name, sha: null}.
 *
 * It's pretty inefficient because it walks through _all_ loose commits
 * to match prefixes against. For now, only looks up commits shas.
 */
HttpRemote.prototype.getShas = function(names, callback) {
  var self = this;
  var results = [];
  for (var i = 0, len = names.length; i < len; i++) {
    var name = names[i];
    results.push({name: name, sha: null, nameType: null})
  }
  var refShas = [];  // list of sha
  this.fetchRefs(function(err, refs) {
    if (err) return callback(err);
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];
      refShas.push(ref.sha);
      for (var j = 0; j < results.length; j++) {
        var result = results[j];
        var name = ref.name;
        if (name.substr(0,5) === 'refs/') name = name.substr(5);
        var slashIndex = name.indexOf('/');
        if (slashIndex !== -1)  // 'remotes' or 'tags' should be excluded.
          name = name.substr(slashIndex+1);
        if (result.name === name) {
          result.sha = ref.sha;
          result.nameType = 'ref';
        }
      }
    }
    
    var needToSearch = false, needToSearchPrefixes = false;
    for (var i = 0; i < results.length; i++) {
      if (results[i].sha) {
        continue;
      } else if (/^[a-f0-9]+$/.test(results[i].name)) {
        needToSearch = true;
        if (results[i].name.length < 40)
          needToSearchPrefixes = true;
      }
    }
    if (! needToSearch)  // All names were refs! no need to search shas.
      return callback(null, results);

    var allTasks = parallel('allTasks');

    // So it's not the name of a ref. Try sha prefixes.
    if (needToSearchPrefixes) {
      for (var i = 0; i < refShas.length; i++) {
        findShasLoose(refShas[i], allTasks.newCallback());
      }
    } else {
      findFullShasLoose(allTasks.newCallback());
    }
    findShasInPacks(allTasks.newCallback());
    allTasks.await(function(err) {
      if (err) return callback(err);
      return callback(null, results);
    });
  });


  function parallel(name) {
    var numWaiting = 0, error = null;
    var knownCallback = null;
    return {
      newCallback: function() {
        numWaiting++;
        var alreadyCalled = 0;
        return function(err) {
          if (alreadyCalled++)
            throw new Error("Callback already called " + alreadyCalled + " time(s)");
          numWaiting--;
          //console.log('parallel',name,':',numWaiting,'left');
          if (error) return;
          if (err) error = err;
          if (knownCallback) {
            if (error) return knownCallback(error);
            if (numWaiting === 0) return knownCallback();
          }
        }
      },
      await: function(cb) {
        knownCallback = cb;
        if (error) return cb(error);
        if (numWaiting === 0) return cb();
      }
    }
  }

  // Some names might be prefixes. Since we can't do directory listings
  // using plain HTTP, we just walk the ENTIRE loose graph looking for
  // the prefixes.
  var seenLooseShas = {};  // sha -> true
  function findShasLoose(sha, cb) {
    if (seenLooseShas[sha]) return cb();
    seenLooseShas[sha] = true;
    for (var j = 0; j < results.length; j++) {
      var result = results[j];
      if (result.name === sha.substr(0, result.name.length) &&
          result.nameType !== 'ref') {
        if (result.sha && result.sha !== sha)
          return cb(new Error("Ambiguous name: " + result.name));
        result.sha = sha;
        result.nameType = 'sha';
      }
    }
    self.fetchObjectLoose(sha, function(err, commit) {
      if (! commit) return cb();  // Note: Eat any 404s!
      var finishedLooseAncestors = parallel('finishedLooseAncestors');
      for (var i = 0, len = commit.parents.length; i < len; i++) {
        var parentSha = commit.parents[i];
        findShasLoose(parentSha, finishedLooseAncestors.newCallback());
      }
      finishedLooseAncestors.await(cb);
    });
  }
  // All names to lookup are 40 characters. Look them up directly.
  function findFullShasLoose(cb) {
    var allFullShasSearched = parallel();
    for (var j = 0; j < results.length; j++) {
      var result = results[j];
      if (result.name.length === 40 && result.nameType !== 'ref' &&
          /^[a-f0-9]+$/.test(result.name) && ! result.sha) {
        (function(result, cb) {
          console.log('searching full loose for ' + result.name);
          self.fetchObjectLoose(result.name, function(err, data) {
            if (data)
              result.sha = result.name;
            cb();
          });
        })(result, allFullShasSearched.newCallback());
      }
    }
    allFullShasSearched.await(cb);
  }
  function findShasInPack(packSha, cb) {
    // packs[packSha] is not useful until you fetchPackIndex.
    self.fetchPackIndex(packSha, function(err, packIndex) {
      for (var j = 0; j < results.length; j++) {
        var result = results[j];
        if (result.nameType !== 'ref') {
          var ix = packIndex.indexOfSha(result.name);
          if (ix != null && ix >= 0) {  // not null, and not -1.
            var sha = packIndex.shaAtIndex(ix);
            if (result.sha && result.sha !== sha) {
              return cb(new Error("Ambiguous name: " + result.name));
            }
            console.log('found packed ' + result.name);
            result.sha = sha;
            result.nameType = 'sha';
          } else if (ix == -1) {  // multiple commits match
            return cb(new Error("Ambiguous name: " + result.name));
          }
        }
      }
      return cb();
    });
  }
  function findShasInPacks(cb) {
    self.fetchPackList(function(err, packs) {
      if(err) return cb(err);
      var scannedAllPacks = parallel('scannedAllPacks');
      for (var packSha in packs) {
        findShasInPack(packSha, scannedAllPacks.newCallback());
      }
      scannedAllPacks.await(cb);
    });
  }
};

HttpRemote.prototype.getObject = function(sha, callback) {
  if (sha == "" || !sha) { return callback(null) }
  var remote = this

  var object = this.getObjectFromCachedPacks(sha, function(err, object) {
    if(err) return callback(err);
    if(object) return callback(null, object);
    remote.fetchObjectLoose(sha, function(err, object) {
      if (object) {
        callback(null, object)
      } else {
        remote.fetchObjectPacked(sha, callback)
      }
    })
  })
}

/**
 * Tries to find the object in a packfile that has already been cached.
 *
 * Will call ready exactly once:
 * ready(null, obj) if object was found in an already fetched pack files.
 * ready(err) if the object was found but couldn't be parsed.
 * ready(null, null) if object was not in one of the already fetched pack files.
 */
HttpRemote.prototype.getObjectFromCachedPacks = function(sha, ready) {
  var remote = this
  var found = false;
  if (this.packs) {
    _(_(this.packs).keys()).each(function(packSha) {
      if (found) return;
      var packInfo = remote.packs[packSha]
      if (packInfo.index && packInfo.pack) {
        var offset = packInfo.index.getOffset(sha)
        if (offset) {
          found = true;
          packInfo.pack.getObjectAtOffset(offset, ready);
        }
      }
    });
  }
  if (!found)
    ready()
}

HttpRemote.prototype.fetchObjectLoose = function(sha, callback) {
  var uri = this.makeObjectUri(sha)
  http.get(uri, function(err, data) {
    err ? callback(err) : HttpRemote.parseObjectData(sha, data, function(err, data) {
      callback(null, data);
    });
  })
}

HttpRemote.prototype.fetchObjectPacked = function(sha, callback) {
  var remote = this
  this.fetchPackList(function(err, packs) {
    if(err) return callback(err);

    var expecting = 0;
    _(_(packs).keys()).each(function(packSha) {
      remote.fetchPackIndex(packSha, function(err, packIndex) {
        var offset = packIndex.getOffset(sha)
        if (offset) {
          ++expecting;
          remote.fetchPackFile(packSha, function(err, packFile) {
            packFile.getObjectAtOffset(offset, function(err, data) {
              callback(err, data)
            })
          })
        }
      })
    })
  })
}

HttpRemote.prototype.fetchPackList = function(callback) {
  var remote = this
  if (remote.packs) {
    callback(null, remote.packs)
  } else {
    var uri = this.makeUri("/objects/info/packs")
    http.get(uri,  function(err, data) {
        if(err) return callback(err);

        remote.packs = {}
        _(HttpRemote.parsePackList(data)).each(function(packSha) {
          remote.packs[packSha] = {index: null, pack: null}
        })
        callback(null, remote.packs)
    })
  }
}

HttpRemote.prototype.fetchPackIndex = function(sha, callback) {
  if (this.packs && this.packs[sha] && this.packs[sha].index) {
    callback(null, this.packs[sha].index)
  } else {
    var uri = this.makeUri("/objects/pack/pack-" + sha + ".idx")
    var remote = this

    http.get(uri, function(err, data) {
        if(!err) {
          var packIndex = new PackIndex(data)
          remote.packs[sha].index = packIndex
          callback(null, packIndex)
        } else callback(err)
    })
  }
}

HttpRemote.prototype.fetchPackFile = function(sha, callback) {
  if (this.packs && this.packs[sha] && this.packs[sha].pack) {
    callback(null, this.packs[sha].pack)
  } else {
    var uri = this.makeUri("/objects/pack/pack-" + sha + ".pack")
    var remote = this
    http.get(uri, function(err, data) {
        if(err) return callback(err);
        var packFile = new Pack(data)
        remote.packs[sha].pack = packFile
        callback(null, packFile)
    })
  }
}

HttpRemote.prototype.makeObjectUri = function(sha) {
  return this.makeUri("/objects/" + sha.slice(0, 2) + "/" + sha.slice(2))
}


// Parses the contents of the .git/info/refs file
HttpRemote.parseInfoRefs = function(data) {
  var lines = data.split("\n")
  var refs = []
  _(lines).each(function(line) {
    if (line !== "") {
      var tabStops = line.split("\t")
      var ref = {name: tabStops[1], sha: tabStops[0]}
      refs.push(ref)
    }
  })
  return refs
}

HttpRemote.parsePackList = function(data) {
  var lines = data.split("\n")
  var packs = []
  _(lines).each(function(line) {
    if (line !== "") {
      var packSha = /pack-(.*)\.pack/.exec(line)[1]
      packs.push(packSha)
    }
  })
  return packs
}

HttpRemote.parseObjectData = function(sha, compressedData, ready) {
  inflate(compressedData, 2, function(err, data) {
    var offset = 0
    
    var peek = function(length) {
      return data.slice(offset, offset + length)
    }
    
    var rest = function() {
      return data.slice(offset)
    }
    
    var advance = function(length) {
      offset += length
    }
    
    var type = peek(3)
    advance(3)
    if (type === "com") {
      type = "commit"
      advance(4)
    } else if (type === "blo") {
      type = "blob"
      advance(2)
    } else if (type === "tre") {
      type = "tree"
      advance(2)
    } else {

      throw new Error("can't determine type of object: "+type+" "+data)
    }
    
    var nextByte = -1
    while (nextByte !== 0) {
      nextByte = peek(1).charCodeAt(0)
      advance(1)
    }
    ready(null, Objects.make(sha, type, rest()))
  });
}

module.exports = exports = HttpRemote
