var MemoryRepo = Git.require('lib/git/memory_repo')
  , GithubProxyRepo = Git.require('lib/git/github_repo')
  , TreeDiff = Git.require('lib/git/tree-diff')
  , _ = Git.require('underscore')
  , MyMD5 = Git.require('vendor/md5')

RepoViewer = {
  repo: null,
  
  showRef: function(remoteAndRefName) {
    var remoteName = remoteAndRefName.split("/")[0]
    var refName = remoteAndRefName.split("/")[1]
    var origin = RepoViewer.repo.getRemote(remoteName)
    var ref = origin.getRef(refName)
    RepoViewer.repo.getObject(ref.sha, function(err, firstCommit) {
      RepoViewer.displayCommit(firstCommit)
      RepoViewer.highlightCommit(firstCommit.sha)
      RepoViewer.repo.getObject(firstCommit.tree, function(err, tree) { 
        RepoViewer.displayCommitDiff(firstCommit)
        RepoViewer.displayTree(tree) 
      })
      RepoViewer.displayCommitAndParents(firstCommit, 10)
    })
  },
  revList: function(argString) {
    var filter = {cursor: []};
  },
  revParse: function(argString, callback) {
    var todo = 0;
    var as_is = false;
    var args = argString.split(/\s+/);
    var i = 0; 
    var commits = [], files = [];
    parseNextArg(null);
    var parsed = [];
    function parseNextArg(err, prevResult) {
      if (err != null) return callback(err);
      if (prevResult != null) parsed.push(prevResult);
      if (i === args.length)
        return callback(null, parsed);
      var arg = args[i++];
      if (! arg) return parseNextArg(null);
      if (as_is) {
        files.push(arg);
        return parseNextArg(null);
      }
      var m;
      var commitNames = [];  // names with suffixes
      var ops = [];  // What operations to perform after looking up the commits.
      if (m = /([^]*)\.\.\.([^]*)/.exec(arg)) {
        // symmetric difference
        commitNames.push(m[1] === "" ? "HEAD" : m[1]);
        commitNames.push(m[2] === "" ? "HEAD" : m[2]);
        ops.push({
            commits: [commitNames.length - 2, commitNames.length - 1],
            op: 'identity',
            include: true});
        ops.push({
            commits: [commitNames.length - 2, commitNames.length - 1],
            op: 'merge-base',
            include: false});
      } else if (m = /([^]*)\.\.([^]*)/.exec(arg)) {
        // difference
        commitNames.push(m[1] === "" ? "HEAD" : m[1]);
        commitNames.push(m[2] === "" ? "HEAD" : m[2]);
        ops.push({
            commits: [commitNames.length - 2],
            op: 'identity',
            include: false});
        ops.push({
            commits: [commitNames.length - 1],
            op: 'identity',
            include: true});
      } else if (m = /([^]+)^!/.exec(arg)) {
        // include commit but exclude all its parents.
        commitNames.push(m[1]);
        ops.push({
            commits: [commitNames.length - 1],
            op: 'identity',
            include: true});
        ops.push({
            commits: [commitNames.length - 1],
            op: 'parents',
            include: false});
      } else if (m = /([^]+)^@/.exec(arg)) {
        // all parents of commit.
        commitNames.push(m[1]);
        ops.push({
            commits: [commitNames.length - 1],
            op: 'parents',
            include: true});
      } else if ('^' === arg.charAt(0)) {
        commitNames.push(arg.substr(1));
        ops.push({
            commits: [commitNames.length - 1],
            op: 'identity',
            include: false});
      } else {
        commitNames.push(arg);
        ops.push({
            commits: [commitNames.length - 1],
            op: 'identity',
            include: true});
      }
    
      RepoViewer.getNamesWithSuffixes(commitNames, function(err, commits) {
        var result = [];
        if (err) return parseNextArg(err);
        var j = 0;
        handleNext();


        // TODO: fetch them in parallel
        function handleNext() {
          if (j === ops.length) return parseNextArg(null, result);
          var op = ops[j];
          j++;
          if ('identity' === op.op) {
            result.push({commit: commits[op.commits[0]], include: op.include});
            return handleNext();
          } else if ('parents' === op.op) {
            RepoViewer.repo.getObject(commits[op.commits[0]], function(err, parents) {
              if (err) return parseNextArg(err);
              Array.prototype.push.apply(result, parents);
              for (var i = 0; i < parents.length; i++) {
                result.push({commit:parents[i], include: op.include});
              }
              return handleNext();
            });
          } else if ('merge-base' === op.op) {
            RepoViewer.getMergeBase([commits[op.commits[0]], commits[op.commits[1]]],
                function(err, mergeBases) {
              if (err) return onNamesRetrieved(err);
              for (var i = 0; i < mergeBases.length; i++) {
                result.push({commit:mergeBases[i], include:op.include});
              }
              return handleNext();
            });
          } else {
            return parseNextArg(new Error('Unknown internal operation: '  + op.op));
          }
        }
      });
    }
  },
  getNamesWithSuffixes: function(namesWithSuffixes, callback) {
    var names = [];
    var suffixes = [];
    for (var i = 0; i < namesWithSuffixes.length; i++) {
      var nameWith = namesWithSuffixes[i];
      var firstCaret = nameWith.indexOf('^')
        , firstTilde = nameWith.indexOf('~');
      var suffixStart = nameWith.length;
      if (-1 !== firstCaret) suffixStart = firstCaret;
      if (-1 !== firstTilde && firstTilde < suffixStart) suffixStart = firstTilde;
      var name = nameWith.substr(0, suffixStart)
        , suffix = nameWith.substr(suffixStart);
      names.push(name);
      suffixes.push(suffix);
    }
    RepoViewer.repo.getShas(names, function(err, getShasResult) {
      if (err) return callback(err);
      var unknownNames = [], shas = [];
      for (var k = 0; k < getShasResult.length; k++) {
        if (null == getShasResult[k].sha)
          unknownNames.push(getShasResult[k].name);
        shas.push(getShasResult[k].sha);
      }
      if (0 !== unknownNames.length) {
        var s = unknownNames.length == 1 ? "" : "s";
        return callback(new Error("Unknown name"  + s + ": " + unknownNames.join(", ")));
      }
      unknownNames = undefined;
      walkSuffixes(shas, suffixes, callback);
    });
    
    /** Given a list of */
    function walkSuffixes(shas, suffixes, callback) {
      if (shas.length !== suffixes.length)
        return callback(new Error("Shas and suffixes must have same length"));
      var result = [];  // list of sha
      doItem(0);
      function doItem(i) {
        if (i === names.length) return callback(null, result);
        var sha = shas[i]
          , suffix = suffixes[i];
        walkSuffix(sha, suffix, 0, function(err, sha) {
          if (err) return callback(err);
          result.push(sha);
          doItem(i + 1);
        });
      }
    }
    /** Starting with a sha, walks up the ancestry to resolve the suffix
      * (^, ~10, etc). Not too many suffixes are understood yet.
      */
    function walkSuffix(sha, suffix, i, callback) {
      if (i >= suffix.length) return callback(null, sha);
      var zeroOrd = '0'.charCodeAt(0), nineOrd = '9'.charCodeAt(0);
      if ('^' === suffix.charAt(i)) {
        i++;
        var parentIndex = 0, hasParentIndex = false;
        var c;
        while (zeroOrd <= (c = suffix.charCodeAt(i)) && c <= nineOrd) {
          hasParentIndex = true;
          parentIndex = parentIndex * 10 + c - zeroOrd;
          i++;
        }
        if (! hasParentIndex) parentIndex = 1;
        if (0 === parentIndex)  // ^0 means the commit itself
          return walkSuffix(sha, suffix, i, callback);

        RepoViewer.repo.getObject(sha, function(err, commit) {
          if (err) return callback(err);
          if ("commit" !== commit.type)
            return callback(new Error(
                "Sha " + sha + " was expected to be a commit; was " +
                commit.type));
          if (parentIndex - 1 >= commit.parents.length)
            return callback(new Error("In " + suffix + ", " + sha + " has no parent " + parentIndex));
          return walkSuffix(commit.parents[parentIndex-1], suffix, i, callback);
        });
      } else if ('~' === suffix.charAt(i)) {
        i++;
        var ancestorLevel = 0;
        var c;
        while (zeroOrd <= (c = suffix.charCodeAt(i)) && c <= nineOrd) {
          ancestorLevel = ancestorLevel * 10 + c - zeroOrd;
          i++;
        }
        getNthAncestor(sha, ancestorLevel, function(err, ancestorSha) {
          if (err) return callback(err);
          return walkSuffix(ancestorSha, suffix, i, callback);
        });
        function getNthAncestor(sha, ancestorLevel, callback) {
          if (ancestorLevel === 0) return walkSuffix(sha, suffix, i, callback);
          RepoViewer.repo.getObject(sha, function(err, commit) {
            if (err) return callback(err);
            if ("commit" !== commit.type)
              return callback(new Error(
                  "Sha " + sha + " was expected to be a commit; was " +
                  commit.type));
            if (0 === commit.parents.length)
              return callback(new Error(sha + " has no parent"));
            return getNthAncestor(commit.parents[0], ancestorLevel-1, callback);
          });
        }
      } else {
        return callback(new Error(
            "Could not understand suffix " +
            suffix + " starting at " + i +
            "(" + suffix.charAt(i) + ")"));
      }
    }
  },
  getMergeBase: function(commits, callback) {
    return callback(new Error("Not implemented yet!"));
    var seen = {};  // commit -> true
    for (var i = 0; i < commits.length; i++) {
      var commit = commits[i];
      RepoViewer.repo.getObject(commit, function(err, result) {
      });
    }
    RepoViewer.repo.getObject(commit);
  },
  
  clearTree: function() {
    $("#top-directory").html("")
  },
  
  highlightCommit: function(sha) {
    $("#commits .displayed").removeClass("displayed")
    $("#commit-" + sha).addClass("displayed")
  },
  
  attachCommitClickEvents: function() {
    function activated(e) {
      e.preventDefault()
      var id = $(e.target).attr("id")
      if (id.split("-")[0] == "commit") {
        var sha = id.split("-")[1]
        RepoViewer.repo.getObject(sha, function(err, commit) {
          RepoViewer.repo.getObject(commit.tree, function(err, tree) { 
            RepoViewer.displayCommitDiff(commit)
            RepoViewer.displayTree(tree) 
          })
        })
        RepoViewer.highlightCommit(sha)
        RepoViewer.clearFileView()
      }
    }
    $(".commit").click(activated).keydown(function(e) {
      if (13 === e.keyCode) activated(e);
    });
  },
  
  displayCommitDiffInfo: function(commit) {
    var str = ""
    str += "<div class='commit-info'>"
    str += "<div class='gravatar'>"
    str += "<img src='http://www.gravatar.com/avatar/" + MyMD5(commit.author.email) + "'>"
    str += "</div>"
    str += "<table>"
    str += "<tr><td>SHA</td><td>" + commit.sha + "</td></tr>"
    str += "<tr><td>Committer</td><td>" + commit.committer.name + 
      " &lt;" + commit.committer.email + "&gt;" + "</td></tr>"
    str += "<tr><td>Author</td><td>" + commit.author.name + 
      " &lt;" + commit.author.email + "&gt;" + "</td></tr>"
    str += "<tr><td>Committed</td><td>" + commit.committer.date.toUTCString() + "</td></tr>"
    str += "<tr><td>Authored</td><td>" + commit.author.date.toUTCString() + "</td></tr>"
    _(commit.parents).each(function(parentSha) {
      str += "<tr><td>Parent</td><td>" + parentSha + "</td></tr>"
    })
    str += "</table></div>"
    str += "<hr>"
    str += "<pre class='message'>" + commit.message + "</pre>"
    
    $("#diff").html(str)
  },
  
  displayCommitDiffDiff: function(commit) {
    RepoViewer.repo.getObject(commit.parents[0], function(err, parent) {
      if (err) throw err;
      var parentTree = parent ? parent.tree : null
      var treeDiff = new TreeDiff(RepoViewer.repo, parentTree, commit.tree)
      treeDiff.toHtml(function(html) {
        $("#diff").append(html)
      })
    })
  },
  
  displayCommitDiff: function(commit) {
    RepoViewer.displayCommitDiffInfo(commit)
    if (commit.parents.length > 1) {
      $("#diff").append("Multiple parents.")
    }
    else {
      RepoViewer.displayCommitDiffDiff(commit)
    }
  },
  
  attachMoreCommitsEvents: function() {
    function activated(e) {
      e.preventDefault()
      var id = $(e.target).closest('[id]').attr("id");
      $(e.target).closest('tr').prev('tr').find('[tabindex]').focus()
      $(e.target).closest('tr').remove();
      if (id.split("-")[0] == "more") {
        var sha = id.split("-")[1]
        RepoViewer.repo.getObject(sha, function(err, commit) {
          RepoViewer.displayCommitAndParents(commit, 10, function() {
            // $("#commits").scrollTop = $("#commits").height;
          })
        })
      }
    }
    $(".more-commits").click(activated).keydown(function(e) {
      if (13 === e.keyCode) activated(e);
    });
  },
  
  displayCommit: function(commit) {
    if ($("#commit-" + commit.sha).length == 0) {
      var row = "<tr>"
      row += "<td class=\"commit\" id=\"commit-" + commit.sha + "\" tabindex=0>" + commit.message.split("\n")[0] + "</td>"
      row += "<td>" + commit.author.name  + "</td>"
      
      row += "<td>" + commit.author.date.toUTCString() + "</td>"
      row += "</tr>"
      $("#commits table").append(row)
    }
  },
  
  displayCommitAndParents: function(commit, max, callback) {
    this.displayCommit(commit)
    if (max == 0) {
      this.attachCommitClickEvents()
      var row = "<tr><td><a class='more-commits' id='more-" + commit.sha + "' tabindex=0><em>More...</em></a></td></tr>"
      $("#commits table").append(row)
      this.attachMoreCommitsEvents()
      if (callback) { callback() }
    } else {
      if (parentSha = commit.parents[0]) {
        RepoViewer.repo.getObject(commit.parents[0], function(err, parent) {
          RepoViewer.displayCommitAndParents(parent, max - 1, callback)
        })
      } else {
        this.attachCommitClickEvents()
        if (callback) { callback() }
      }
    }
  },
  
  clearCommits: function() {
    $("#commits table").html("")
  },
  
  displayTree: function(tree, target) {
    if (!target) {
      RepoViewer.clearTree()
      target = $("#top-directory")
    }
    _(tree.contents).each(function(row) {
      var linkNode = $("<a>" + row.name + "</a>")
      var rowNode = $("<li></li>")
      linkNode.appendTo(rowNode)
      rowNode.appendTo(target)
      var subTreeNode = $("<ul></ul>")
      subTreeNode.appendTo(rowNode)
      if (row.mode == "040000") { // directory
        linkNode.click(function(e) {
          RepoViewer.repo.getObject(row.sha, function(err, tree) { RepoViewer.displayTree(tree, subTreeNode) })
        })
      } else { // file
        linkNode.click(function(e) {
          e.preventDefault()
          RepoViewer.repo.getObject(row.sha, function(err, blob) { 
            $("#file-main").html("<pre id='file-view'></pre>")
            $("#file-view").addClass("brush: ruby")
            $("#file-view").html(blob.data)
            SyntaxHighlighter.highlight()
          })
        })
      }
    })
  },
  
  clearRefs: function() {
    $("#refs-list").html("<option value=\"\"></option>")
  },
  
  displayRefs: function(refs) {
    var i, ref
    _(refs).each(function(ref) {
      $("#refs-list").append('<option value="' + ref["name"] + '">' + ref["name"] + "</option>")
    })
  },
  
  clearFileView: function() {
    $('#file-view').html("")
  },
  
  displayRemoteLines: function(remoteLines) {
    var i;
    for(i = 0; i < remoteLines.length; i++ ) {
      $('#file-view').append("<br>remote: " + remoteLines[i]);
    }
  },
  
  displayObjects: function(newObjects) {
    $("#objects").append("<li><strong>" + newObjects.length  +" Objects" + "</strong></li>")
    _(newObjects).each(function(object) {
      if (object.type == "tree") {
        var tree = object
        var str = "<li>" + tree.sha + ": <ul>"
        _(tree.contents).each(function(row) {
          str += "<li>" + row.name + ": " + row.sha + "</li>"
        })
        str += "</ul></li><br>"
        $("#objects").append(str)
      }
      else {
        $("#objects").append("<li>" + object.sha + "<br><pre>" + object.data + "</pre></li>")
      }
    })
  },
  
  githubDemo: function(username, reponame, password) {
    RepoViewer.repo = new GithubProxyRepo(username, reponame, password)
    var origin = RepoViewer.repo.getRemote("origin")
    origin.fetchRefs(function() {
      RepoViewer.displayRefs(RepoViewer.repo.getAllRefs())
    })
  },
  
  clearErrors: function() {
    $("#Git-errors").html("")
  },
  
  demo: function(uri) {
    RepoViewer.clearTree()
    RepoViewer.clearFileView()
    RepoViewer.clearRefs()
    RepoViewer.clearCommits()
    RepoViewer.clearErrors()
    var repo = new MemoryRepo()
    RepoViewer.repo = repo
    console.log("creating repo with origin: " + uri)
    // if (uri.indexOf("//github.com")) {
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        // 
    // } else {
      repo.addRemote("origin", uri)
      var origin = repo.getRemote("origin")
      origin.fetchRefs(function() {
        RepoViewer.displayRefs(repo.getAllRefs())
      })
    
  }
}
