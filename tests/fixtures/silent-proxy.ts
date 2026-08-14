// A proxy entrypoint that exits without ever writing a handshake signal, so
// spawnAgy() has to notice the dead child instead of waiting on the pipe.
process.exit(3);
