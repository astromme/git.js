
/* Main object */

var Git = function() {

};

// constants

Git.OBJECT_TYPES  = ["tag", "commit", "tree", "blob"]
Git.REMOTE_TYPE   = 'HttpRemote'

Git.prototype.handleError = typeof console !== 'undefined' ?
    function() { console.log.apply(console, arguments) } :
    function() { (this._logs || []).push([].slice.call(arguments)) }

// Turn an array of bytes into a String
Git.prototype.bytesToString = function(bytes) {
    var result = [];
    var i;
    for (i = 0; i < bytes.length; i++) {
      result.push(String.fromCharCode(bytes[i]));
    }
    return result.join('');
};

Git.prototype.stringToBytes = function(string) {
    var bytes = []; 
    var i; 
    for(i = 0; i < string.length; i++) {
      bytes.push(string.charCodeAt(i) & 0xff);
    }
    return bytes;
};

Git.prototype.toBinaryString = function(binary) {
  return (binary instanceof Array) ?
          this.bytesToString(binary) :
          binary
};

Git.prototype.nextPktLine = function(data) {
  var len = parseInt(data.slice(0, 4), 16);
  return data.slice(4, len);
};
 
Git.prototype.stripZlibHeader = function(zlib) {
  return zlib.slice(2);
}
 
Git.prototype.escapeHTML = function(str) {
    return str.replace(/\&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
               replace(/'/g, '&#39;');
};

module.exports = exports = Git
