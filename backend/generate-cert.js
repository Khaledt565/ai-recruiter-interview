// Generate self-signed SSL certificate for backend
import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.join(__dirname, 'certs');

// Create certs directory if it doesn't exist
if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir, { recursive: true });
}

// Generate a key pair
const pem = forge.pki.rsa.generateKeyPair(2048);

// Create a self-signed certificate
const cert = forge.pki.createCertificate();
cert.publicKey = pem.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

const attrs = [
  { name: 'commonName', value: '3.73.83.209' },
  { name: 'organizationName', value: 'AI Recruiter' },
  { name: 'countryName', value: 'US' },
];

cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  {
    name: 'basicConstraints',
    cA: true,
  },
  {
    name: 'keyUsage',
    keyCertSign: true,
    digitalSignature: true,
    nonRepudiation: true,
    keyEncipherment: true,
    dataEncipherment: true,
  },
  {
    name: 'extKeyUsage',
    serverAuth: true,
    clientAuth: true,
  },
  {
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: '3.73.83.209' },
      { type: 7, ip: '3.73.83.209' },
    ],
  },
]);

// Self-sign certificate
cert.sign(pem.privateKey, forge.md.sha256.create());

// Convert to PEM
const certPem = forge.pki.certificateToPem(cert);
const keyPem = forge.pki.privateKeyToPem(pem.privateKey);

// Write files
fs.writeFileSync(path.join(certDir, 'server.crt'), certPem);
fs.writeFileSync(path.join(certDir, 'server.key'), keyPem);

console.log('✓ SSL certificates generated for IP: 3.73.83.209');
console.log(`  - Certificate: ${path.join(certDir, 'server.crt')}`);
console.log(`  - Key: ${path.join(certDir, 'server.key')}`);
