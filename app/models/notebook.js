var Git = require("../lib/notebook/git"),
    util = require('util'),
    path = require('path'),
    fs = require('fs'),
    cnst = require('constants'),
    nodefn = require("when/node/function"),
    mkdirp = require("mkdirp"),
    getDirName = require("path").dirname,
    glob = require("glob"),
    when = require('when'),
    _ = require("lodash"),
    keys = require('when/keys');

// File open mode for creating notebook files, will fail if the file already exists
// More info on the const values: http://man7.org/linux/man-pages/man2/open.2.html
var RDWR_EXCL = cnst.O_CREAT | cnst.O_TRUNC | cnst.O_RDWR | cnst.O_EXCL;

module.exports = function(Bookshelf, app) {
  var Notebook = Bookshelf.Model.extend({
    // this is not used but we need to so bookshelf
    // does not complain
    tableName: "Notebooks",

    // Create new notebook repo
    save: function(options) {
      options = options || {};
      // allow for overriding the attributes
      // from the save method
      this.attributes = _.merge(this.attributes, options);

      var notebook = notebookFile(this.get('userId'), this.get('projectId'), this.get('name'), options.relativeRoot);
      var git = new Git(notebook['dir']);
      var self = this;

      return this.getData().then(function(data) {
        if (!data) {
          throw new Error('Invalid notebook format');
        } else {
          return writeFile(notebook['path'], RDWR_EXCL, data)
            .then(git.init.bind(git), _.bind(function(e) {
              console.log("* A notebook with '" + self.get('name') + "' name already exists within this project");
              return Notebook.update(self.attributes);
            }, this))
            .then(git.init.bind(git))
            .then(git.addToIndex.bind(git, [notebook['file']]))
            .then(function(oid) {
              return git.commit(oid, []);
            }).then(function() {
              return self;
            });
        }
      })
    },

    getData: function() {
      var dataPromise;

      if (this.get('path')) {
        dataPromise = readFile(this.get('path'));
      } else {
        dataPromise = when(this.get('data'));
      }
      return dataPromise
    }
  });

  Notebook.list = function(options) {
    var notebooks = notebookFile(options['userId'], options['projectId'], '*/*.bkr');

    return nodefn.call(glob, notebooks.dir)
    .then(function(files) {
      return when.map(files, function(file) {
        return keys.all({
          name: path.basename(file, '.bkr'),
          lastModified: lastModified(file),
          numCommits: numCommits(file)
        });
      });
    });
  }

  Notebook.load = function(options) {
    var notebook = notebookFile(options['userId'], options['projectId'], options['name']);
    return readFile(notebook['path'])
    .then(function(data) {
      return {
        name: options['name'],
        data: data
      };
    });
  };


  // Update existing notebook repo
  Notebook.update = function(options) {
    var notebook = notebookFile(options['userId'], options['projectId'], options['name']);
    var git = new Git(notebook['dir']);

    return writeFile(notebook['path'], 'w', options['data'])
      .then(git.open.bind(git))
      .then(git.addToIndex.bind(git, [notebook['file']]))
      .then(function(oid) {
        return git.head()
          .then(function(parent) {
            return git.commit(oid, [parent]);
          });
      });
  };

  return {
    name: "Notebook",
    model: Notebook
  }
}

module.exports.matchingProjectIds = function(userId, searchTerm) {
  var dir = notebookFile(userId, '**', '*.bkr').dir;

  return nodefn.call(glob, dir)
  .then(function(files) {
    return _(files).map(function(file) {
      // Extract project id and notebook name from the file path
      var match = file.match(/^repos\/\d+\/(\d+)\/(.+)\/.+/)
      if (match.length && contains(match[2], searchTerm)) {
        // return matching project id
        return +match[1];
      }
    }).uniq().compact().value();
  });
}

function contains(a, b) {
  return a.toLowerCase().indexOf(b.toLowerCase()) != -1;
}

function notebookFile(userId, projectId, name, relativeRoot) {
  relativeRoot = relativeRoot || "";

  var file = name + ".bkr";
  var dir = path.join(relativeRoot, "repos", userId.toString(), projectId.toString(), name);
  return {
    path: path.join(dir, file),
    dir: dir,
    file: file
  };
}

function writeFile(filePath, flag, contents) {
  var data = JSON.stringify(contents, null, 4);
  return nodefn.call(mkdirp, getDirName(filePath))
     .then(nodefn.lift(fs.writeFile, filePath, data, {flag: flag, encoding: 'utf8'}));
}

function readFile(filePath) {
  return nodefn.call(fs.readFile, filePath)
    .then(function(data) {
      return JSON.parse(data);
    });
}

function lastModified(filePath) {
  return nodefn.call(fs.stat, filePath)
    .then(function(data) {
      return data.mtime;
    });
}

function numCommits(filePath) {
  var git = new Git(path.dirname(filePath));

  return git.open()
    .then(git.numCommits.bind(git));
}
