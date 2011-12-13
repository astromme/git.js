var BinaryFile = require('../binary_file')
  , _ = require('underscore')

require('../string_helpers')

// This object partially parses the data contained in a pack-*.idx file, and provides
// access to the offsets of the objects the packfile and the crc checksums of the objects.
var PackIndex = function(data) {
  this.data = new BinaryFile(data)
  
  if (!this.assertVersion(2)) {
    throw(Error("pack index is not version 2"))
  }
  var info = this.offsetInfo()
  this.offsets = info.offsets
  this.maxOffset = info.max
}

PackIndex.prototype.bytesToInteger = function(bytes) {
  var val = 0
  _(bytes).each(function(b) {
    val += b
    val *= 256
  })
  return val/256
}

PackIndex.prototype.bytesToSha = function(bytes) {
  return _(bytes).map(function(b) { return b.toString(16).rjust(2, "0")}).join("")
}

PackIndex.prototype.numObjects = function() {
  return this.bytesToInteger(this.data.slice(8 + 255*4, 8 + 255*4 + 4))
}

// Return the offset within the packfile of the object with the given sha.
PackIndex.prototype.getOffset = function(sha) {
  var numObjects = this.numObjects()
  var ix = this.indexOfSha(sha)
  return this.offsets[ix]
}

// Return the checksum of the object with the given sha.
PackIndex.prototype.getCrc = function(sha) {
  var numObjects = this.numObjects()
  var crcArrayOffset = 8 + 256*4 + numObjects*20
  var ix = this.indexOfSha(sha)
  var offset = crcArrayOffset + ix*4
  return this.bytesToInteger(this.data.slice(offset, offset + 4))
}

// Does this pack index contain 64b offsets?
PackIndex.prototype.has64bOffsets = function() {
  var numObjects = this.numObjects()
  var expectedLength = 8 + 256*4 + numObjects*20 + numObjects*4 + numObjects*4 + 40
  return this.data.length > expectedLength + 7 // 64b offsets are 8 bytes
}

// Returns the index offset into the sha array which is the first occurrence
// of shas with first byte matching the first byte of the given sha.
PackIndex.prototype.fanout = function(sha) {
  var fanoutIndex = parseInt(sha.slice(0, 2), 16) - 1;
  var minIndex, maxIndex;
  if (fanoutIndex === -1) {
    minIndex = 0;
  } else {
    minIndex = this.bytesToInteger(
        this.data.slice(8 + fanoutIndex*4, 8 + fanoutIndex*4 + 4));
  }
  maxIndex = this.bytesToInteger(
        this.data.slice(8 + (fanoutIndex+1)*4, 8 + (fanoutIndex+1)*4 + 4));
  return {min: minIndex, max: maxIndex};
}

// Returns the index of this sha into the three arrays: sha[], crc[] and offset[]
// If sha is fewer than 20 characters, then returns the index of the
// sha that completes it.
// If the sha is not in the index file, then returns null.
// If the name is ambiguous (fewer than 20 characters and multiple shas match),
// then returns -1.
PackIndex.prototype.indexOfSha = function(sha) {
  var bounds = this.fanout(sha)
  var min = bounds.min, max = bounds.max;
  while (min < max) {
    var ix = (min + max) >> 1;  // flooring division
    var currentSha = this.shaAtIndex(ix);
    if (sha < currentSha)
      max = ix;
    else if (currentSha < sha)
      min = ix+1;
    else return ix;
  }
  var currentSha = this.shaAtIndex(min);
  if (sha.length < currentSha.length) {
    if (currentSha.substr(0, sha.length) === sha) {
      if (min < bounds.max) {
        var nextSha = this.shaAtIndex(min + 1);
        if (nextSha.substr(0, sha.length) === sha) {
          return -1;  // Ambiguous! Two shas have the same substring!
        }
      }
      return min;
    }
  } else {
    return sha === currentSha ? min : null;
  }
}

// Returns the sha at the given index into the sha array
PackIndex.prototype.shaAtIndex = function(ix) {
  var shaArrayOffset = 8 + 256*4
  var offset = shaArrayOffset + ix*20
  return this.bytesToSha(this.data.slice(offset, offset + 20))
}

// Extracts the offset array from the data, and gets the maximum offset
// Return {offsets: [int], max: int}
PackIndex.prototype.offsetInfo = function() {
  var offsets = []
  var numObjects = this.numObjects()
  var offsetArrayOffset = 8 + 256*4 + numObjects*20 + numObjects*4
  var i
  var max = 0
  for (i = 0; i < numObjects; i++) {
    var offsetBytes = this.data.slice(offsetArrayOffset + i*4, offsetArrayOffset + i*4 + 4)
    var offset = this.bytesToInteger(offsetBytes)
    if (offset > max) { max = offset}
    offsets.push(offset)
  }
  return {offsets: offsets, max: max}
}

// Returns an estimate (a lower bound) of the size of the packfile. 
PackIndex.prototype.estimatedPackFileSize = function() {
  return this.maxOffset
}
  
PackIndex.prototype.assertVersion = function(expectedVersion) {
  var versionBytes = this.data.slice(4, 8)
  return _(versionBytes).isEqual([0, 0, 0, expectedVersion])
}

PackIndex.assertVersion = function(data, expectedVersion) {
  return PackIndex.prototype.assertVersion.call({data:data}, expectedVersion)
}

module.exports = exports = PackIndex
