#!/usr/bin/env node
import AdmZip from 'adm-zip';
import { createConnection } from 'net';

const USB_IP = '10.11.99.1';

function rawGet(path, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: USB_IP, port: 80 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
    let rawBuf = Buffer.alloc(0);
    let headersDone = false, contentLength = -1, bodyStart = 0;
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.0\r\nHost: ${USB_IP}\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      if (!headersDone) {
        const sep = rawBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        headersDone = true; bodyStart = sep + 4;
        const headers = rawBuf.slice(0, sep).toString();
        const m = headers.match(/content-length:\s*(\d+)/i);
        if (m) contentLength = parseInt(m[1]);
      }
      const body = rawBuf.slice(bodyStart);
      if (contentLength >= 0 && body.length >= contentLength) {
        socket.destroy(); clearTimeout(timer); resolve(body.slice(0, contentLength));
      }
    });
    socket.on('end', () => { clearTimeout(timer); resolve(rawBuf.slice(bodyStart)); });
    socket.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

const docsRaw = await rawGet('/documents/', 5000);
const docs = JSON.parse(docsRaw.toString());
const doc = docs.filter(d => d.Type === 'DocumentType')
  .sort((a, b) => new Date(b.ModifiedClient) - new Date(a.ModifiedClient))[0];

console.log('Document:', doc.VissibleName, '\nID:', doc.ID);

const buf = await rawGet(`/download/${doc.ID}/rmdoc`);
console.log('rmdoc size:', buf.length, 'bytes\n');

const zip = new AdmZip(buf);
console.log('ZIP contents:');
zip.getEntries().forEach(e => console.log(' ', e.entryName, `(${e.header.size} bytes)`));

const contentEntry = zip.getEntries().find(e => e.entryName.endsWith('.content'));
if (contentEntry) {
  console.log('\n.content path:', contentEntry.entryName);
  console.log(zip.readAsText(contentEntry).slice(0, 800));
}
