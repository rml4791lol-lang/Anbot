// Sign a macOS self-update package, and make the key pair the app checks it with.
//
//   node scripts/sign-update.mjs keygen            # once: keys/update-key.pub + build/update-key
//   node scripts/sign-update.mjs sign <zip>        # writes <zip>.sig beside the zip
//
// The private key never goes into the repository or the app: it is read from ANBOT_UPDATE_KEY
// (base64 of its PKCS#8 DER) when set, from build/update-key otherwise. The public key in
// keys/update-key.pub is packaged as the app's resources/update-key.pub, and a build without it
// keeps asking the user to download the release by hand.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, '..', 'build')
// The public key is committed beside the app so a build always ships the same one; the private
// key stays in build/, which the global gitignore keeps out of every commit.
const publicFile = join(here, '..', 'keys', 'update-key.pub')
const privateFile = join(build, 'update-key')

// Node's JWK import of an OKP private key needs the public half too, which a raw seed does not
// carry, so the key file holds the PKCS#8 DER that does.
const privateKeyObject = secret => createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' })

/** @param {string} file @returns {Promise<string>} the file's sha256, in hex */
function digestOf(file) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .once('error', fail)
      .once('end', () => done(hash.digest('hex')))
  })
}

const [command, argument] = process.argv.slice(2)

if (command === 'keygen') {
  let existing = ''
  try { existing = readFileSync(publicFile, 'utf8') } catch {}
  if (existing.trim() !== '') {
    console.error('sign-update: keys/update-key.pub exists; delete it to make a new key pair')
    process.exit(2)
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  mkdirSync(build, { recursive: true })
  mkdirSync(dirname(publicFile), { recursive: true })
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  const secret = privateKey.export({ type: 'pkcs8', format: 'der' })
  writeFileSync(publicFile, `${raw.toString('base64')}\n`)
  writeFileSync(privateFile, `${secret.toString('base64')}\n`, { mode: 0o600 })
  console.log(`sign-update: wrote ${publicFile} and ${privateFile}; keep the private one out of git`)
  process.exit(0)
}

if (command === 'sign') {
  if (argument === undefined) {
    console.error('sign-update: usage: node scripts/sign-update.mjs sign <zip>')
    process.exit(2)
  }
  const secret = process.env.ANBOT_UPDATE_KEY ?? readFileSync(privateFile, 'utf8').trim()
  const key = privateKeyObject(secret)
  // The signature covers the digest, which is what the app verifies: it streams the zip to disk,
  // hashes it, and the swap checks the same digest again before moving anything.
  const digest = await digestOf(argument)
  const signature = sign(null, Buffer.from(digest), key)
  writeFileSync(`${argument}.sig`, `${signature.toString('base64')}\n`)
  console.log(`sign-update: signed ${argument} (${digest.slice(0, 12)}…), key ${createPublicKey(key).export({ format: 'jwk' }).x.slice(0, 10)}…`)
  process.exit(0)
}

console.error('sign-update: usage: node scripts/sign-update.mjs keygen | sign <zip>')
process.exit(2)
