const fs = require('fs');

// Reads a text file that must be a plain file, up to `maxBytes`. Checking `stat.size` alone is not
// enough: a FIFO or /dev/zero reports size 0 and would block or read forever. The file is opened
// first (without following a final symlink) and the checks use that open handle, so the file that
// was checked is the file that is read.
function readRegularFile(file, maxBytes, label = file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} is a symbolic link; use a plain file.`);
  const before = fs.statSync(file);
  if (!before.isFile()) throw new Error(`${label} is not a regular file.`);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (e) {
    if (e.code === 'ELOOP') throw new Error(`${label} is a symbolic link (or was swapped for one while being read); use a plain file.`);
    throw e;
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new Error(`${label} is not a regular file.`);
    if (info.nlink > 1) throw new Error(`${label} has several hard links; use a plain file inside the app folder.`);
    if (info.size > maxBytes) throw new Error(`${label} is larger than ${Math.round(maxBytes / 1024)} KB.`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const n = fs.readSync(fd, buffer, offset, info.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } catch (e) {
      throw new Error(`${label} is not valid UTF-8 text.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readRegularFile };
