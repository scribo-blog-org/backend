import { generateKeyPair, exportJWK } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
});

const privateJwk = await exportJWK(privateKey);
const publicJwk = await exportJWK(publicKey);

console.log('PRIVATE JWK:');
console.log(JSON.stringify(privateJwk, null, 2));

console.log('\nPUBLIC JWK:');
console.log(JSON.stringify(publicJwk, null, 2));
