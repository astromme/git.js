var HttpRemote = require('./http_remote')
  , _ = require('underscore')
  , Objects = require('./objects')

var MemoryRepo = function() {
  this.refs = {}
  this.remotes = {}
  this.objects = {}
};


MemoryRepo.prototype.getRef = function(refname) {
  return this.refs[refname]
}

MemoryRepo.prototype.getRefs = function() {
  return _(this.refs).values()
}

MemoryRepo.prototype.haveRefs = function(refs) {
  var have = []
    , self = this
  _(refs).each(function(ref) {
    if (self.objects[ref.sha] != null) {
      have.push(ref)
    }
  })
  return have
}

MemoryRepo.prototype.getAllRefs = function() {
  return _(this.getRemotes()).reduce(function(memo, remote) {
    return memo.concat(remote.getRefs())
  }, this.getRefs())
}

// Add a ref to this repo. fullName is of the form:
//   refs/heads/master or refs/tags/123
MemoryRepo.prototype.addRef = function(fullName, sha) {
  var type = fullName.split("/")[1]
  var name = fullName.split("/").slice(2).join('/')
  this.refs[name] = {name:name, sha:sha, remote:null, type:type}
}

MemoryRepo.prototype.getRemote = function(name) {
  return this.remotes[name]
}

MemoryRepo.prototype.getRemotes = function() {
  return _(this.remotes).values()
}

MemoryRepo.prototype.addRemote = function(name, url, remote_class) {
  this.remotes[name] = new (remote_class || HttpRemote)(this, name, url)
}

MemoryRepo.prototype.addRemoteObject = function(name, remote) {
  this.remotes[name] = remote
}

MemoryRepo.prototype.makeAndAddObject = function(sha, type, content) {
  this.objects[sha] = Objects.make(sha, type, content)
  return this.objects[sha]
}

MemoryRepo.prototype.addObject = function(object) {
  this.objects[object.sha] = object
  return object
}

MemoryRepo.prototype.getObjectShas = function(sha) {
  return _(this.objects).keys()
}

MemoryRepo.prototype.objectCount = function() {
  return _(this.objects).keys().length
}

MemoryRepo.prototype.getObject = function(sha, callback) {
  var already = this.objects[sha]
  if (already) { return callback(null, already) }

  var remote = this.getRemotes()[0]
    , self = this

  remote.getObject(sha, function(err, object) {
    if (!err && object) {
      self.addObject(object)
    }
    callback(err, object)
  })
}

MemoryRepo.prototype.getShas = function(names, callback) {
  var self = this;
  var results = [];
  for (var i = 0, len = names.length; i < len; i++) {
    var name = names[i];
    results.push({name: name, sha: null, nameType: null})
  }
  for (var refName in this.refs) {
    var ref = this.refs[refName];
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
  for (var sha in this.objects) {
    for (var j = 0; j < results.length; j++) {
      var result = results[j];
      if (result.nameType !== 'ref' &&
          sha.substr(0, result.name.length) === result.name) {
        if (result.sha != null && result.sha !== sha)
          return callback(new Error("Ambiguous name: " + result.name));
        result.sha = sha;
        result.nameType = 'sha';
      }
    }
  }
  for (var remoteName in this.remotes) {
    var remote = this.remotes[remoteName];
    remote.getShas(names, function(err, remoteResults) {
      if (err) return callback(err);
      for (var i = 0; i < results.length; i++) {
        var result = results[i], remoteResult = remoteResults[i];
        if (result.type !== 'ref' && remoteResult.type === 'ref') {
          result.sha = remoteResult.sha;
          result.nameType = remoteResult.nameType;
        } else if (result.type === 'ref' && remoteResult.type === 'ref' &&
            result.sha !== remoteResult.sha) {
          return callback(new Error("Ambiguous name: " + result.name));
        } else if (result.sha && remoteResult.sha &&
            result.sha !== remoteResult.sha) {
          return callback(new Error("Ambiguous name: " + result.name));
        } else if (! result.sha && remoteResult.sha) {
          result.sha = remoteResult.sha;
          result.nameType = remoteResult.nameType;
        }
      }
      return callback(null, results);
    });
  }
};


module.exports = exports = MemoryRepo 
