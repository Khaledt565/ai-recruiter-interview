const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const certDir = path.join(__dirname, 'backend', 'certs');

// Create certs directory if it doesn't exist
if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir, { recursive: true });
}

// Generate RSA key pair
const keys = forge.pki.rsa.generateKeyPair(2048);

// Create certificate
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

const attrs = [
  { name: 'commonName', value: '3.76.85.189' },
  { name: 'organizationName', value: 'AI Recruiter' },
  { name: 'countryName', value: 'DE' }
];

cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([{
  name: 'basicConstraints',
  cA: true
}, {
  name: 'keyUsage',
  keyCertSign: true,
  digitalSignature: true,
  nonRepudiation: true,
  keyEncipherment: true,
  dataEncipherment: true
}, {
  name: 'extKeyUsage',
  serverAuth: true,
  clientAuth: true,
}]);

// Self-sign the certificate
cert.sign(keys.privateKey, forge.md.sha256.create());

// Export to PEM format
const certPem = forge.pki.certificateToPem(cert);
const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

// Write to files
fs.writeFileSync(path.join(certDir, 'server.crt'), certPem);
fs.writeFileSync(path.join(certDir, 'server.key'), keyPem);

console.log('✅ Self-signed certificate generated successfully');
console.log('   Location:', certDir);
console.log('   - server.crt (certificate)');
console.log('   - server.key (private key)');
