#!/usr/bin/env node
/**
 * Generates a VAPID keypair for Web Push.
 *
 * Run this yourself, in your own terminal:  npm run generate:vapid
 *
 * The private key it prints is a real credential — it authenticates your relay to Apple's,
 * Google's, and Mozilla's push services. Treat it like a password: paste it straight into your
 * host's environment-variable settings and don't commit it, paste it into a chat, or store it in
 * a file the repo tracks.
 *
 * The keypair is stable for the life of the deployment. Rotating it invalidates every push
 * subscription your users' browsers hold, so each device stops receiving notifications until it
 * re-subscribes. Generate once, then leave it alone.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

const subject = process.argv[2];

console.log('');
console.log('  VAPID keypair generated.');
console.log('');
console.log('  Set these three environment variables on the relay host:');
console.log('');
console.log('  COMPANION_RELAY_VAPID_PUBLIC_KEY');
console.log(`  ${publicKey}`);
console.log('');
console.log('  COMPANION_RELAY_VAPID_PRIVATE_KEY   <- secret, do not commit or share');
console.log(`  ${privateKey}`);
console.log('');
console.log('  COMPANION_RELAY_VAPID_SUBJECT');
if (subject) {
  console.log(`  ${subject}`);
} else {
  console.log('  mailto:you@example.com     <- replace with your real email address');
  console.log('');
  console.log('  (Pass it as an argument to have it echoed here: npm run generate:vapid -- mailto:you@example.com)');
}
console.log('');
console.log('  The subject must be a mailto: or https: URL. Push services use it to contact you');
console.log('  if your application misbehaves; a bad value can get your pushes rejected.');
console.log('');
console.log('  All three must be set or push stays disabled: the relay starts fine without them,');
console.log('  logs one warning, and serves 404 from /push/vapid-public-key so browsers cannot');
console.log('  subscribe at all.');
console.log('');
