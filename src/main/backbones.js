// BackBones — encrypted peer-to-peer chat between two BonesAI instances.
//
// Strictly ephemeral: messages live in RAM only, never persisted, all session
// state is wiped on close. End-to-end encrypted with NaCl-equivalent crypto
// from Node's stdlib (X25519 ephemeral key exchange + AES-256-GCM per message),
// layered on top of Tailscale's WireGuard tunnel for defence in depth.
//
// Each session generates a fresh keypair. When the session ends, the keys are
// zeroed and any captured ciphertext from the wire can no longer be decrypted.
// No file system writes. No logs.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity → auto-close
const MAX_MESSAGES_IN_MEMORY = 5000;             // hard cap so a runaway session can't grow forever

// One BackBones session. Holds the keys, the peer WebSocket, and a tiny ring
// buffer of plaintext messages — used only to feed the renderer; never serialised.
class BackBonesSession extends EventEmitter {
  constructor({ role }) {
    super();
    this.id = crypto.randomBytes(6).toString('hex');
    this.role = role; // 'initiator' | 'joiner'
    const kp = crypto.generateKeyPairSync('x25519');
    this._privKey = kp.privateKey;
    // Raw 32-byte X25519 pubkey (last 32 bytes of the DER SPKI encoding).
    this._pubKeyRaw = kp.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
    this._sharedKey = null;     // derived after handshake
    this._peerSocket = null;
    this._messages = [];
    this._startedAt = Date.now();
    this._lastActivity = Date.now();
    this._idleTimer = null;
    this._closed = false;
    this._scheduleIdleCheck();
  }

  get publicKeyB64() { return this._pubKeyRaw.toString('base64url'); }
  get fingerprint() {
    // 8-char hex fingerprint the user can read aloud to verify the connection
    // matches what they expected (defence against MITM if the URL was tampered
    // with in the out-of-band channel).
    const h = crypto.createHash('sha256').update(this._pubKeyRaw).digest('hex');
    return h.slice(0, 8).match(/.{2}/g).join(':');
  }

  // Derive the symmetric session key from the peer's X25519 pubkey.
  // peerPubB64 is the base64url-encoded raw 32-byte X25519 public key.
  setPeerKey(peerPubB64) {
    const peerRaw = Buffer.from(peerPubB64, 'base64url');
    if (peerRaw.length !== 32) throw new Error('invalid peer key length');
    // Build an SPKI DER for the peer's pubkey so node's KeyObject importer
    // accepts it. X25519 SPKI is a fixed 12-byte prefix + the 32-byte key.
    const spkiPrefix = Buffer.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
      0x03, 0x21, 0x00,
    ]);
    const peerKey = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, peerRaw]),
      format: 'der',
      type: 'spki',
    });
    const dh = crypto.diffieHellman({ privateKey: this._privKey, publicKey: peerKey });
    // HKDF to derive the AES key — never use the raw DH output as a symmetric
    // key (low-order point attacks etc).
    // hkdfSync returns an ArrayBuffer in some Node versions — wrap in Buffer
    // so we can zeroise it on close and pass it to crypto.create*Cipheriv.
    this._sharedKey = Buffer.from(crypto.hkdfSync('sha256', dh, Buffer.alloc(0), Buffer.from('backbones/aes-256-gcm/v1'), 32));
    // Also derive a fingerprint of the SHARED secret — both ends compute the
    // same value, so reading it aloud verifies "we're talking to each other".
    const f = crypto.createHash('sha256').update(dh).digest('hex');
    this.sharedFingerprint = f.slice(0, 8).match(/.{2}/g).join(':');
  }

  attachPeer(ws) {
    this._peerSocket = ws;
    ws.on('message', (data) => this._onFrame(data));
    ws.on('close', () => this.close('peer disconnected'));
    ws.on('error', () => this.close('peer error'));
  }

  _bump() {
    this._lastActivity = Date.now();
  }
  _scheduleIdleCheck() {
    this._idleTimer = setInterval(() => {
      if (this._closed) return;
      if (Date.now() - this._lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        this.close('idle timeout');
      }
    }, 60 * 1000);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _encrypt(plaintext) {
    if (!this._sharedKey) throw new Error('no shared key');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._sharedKey, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ct, tag]).toString('base64');
  }
  _decrypt(b64) {
    if (!this._sharedKey) throw new Error('no shared key');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 12 + 16) throw new Error('frame too short');
    const nonce = buf.slice(0, 12);
    const tag = buf.slice(buf.length - 16);
    const ct = buf.slice(12, buf.length - 16);
    const dec = crypto.createDecipheriv('aes-256-gcm', this._sharedKey, nonce);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  }

  // Send a user message to the peer.
  sendMessage(text) {
    if (this._closed) throw new Error('session closed');
    if (!this._peerSocket || this._peerSocket.readyState !== 1) throw new Error('peer not connected');
    const trimmed = String(text || '').slice(0, 4096);
    if (!trimmed) return;
    const ct = this._encrypt(trimmed);
    this._peerSocket.send(JSON.stringify({ t: 'msg', d: ct }));
    this._record({ from: 'me', text: trimmed });
    this._bump();
  }

  // Send the handshake (our pubkey as the joining party).
  sendHandshake() {
    if (!this._peerSocket) return;
    this._peerSocket.send(JSON.stringify({ t: 'hello', k: this.publicKeyB64 }));
  }

  _onFrame(data) {
    let j;
    try { j = JSON.parse(data.toString('utf8')); }
    catch (_) { return; }
    if (j.t === 'hello' && j.k && !this._sharedKey) {
      try {
        this.setPeerKey(j.k);
        this.emit('connected');
        this._bump();
      } catch (e) {
        this.close('handshake failed');
      }
      return;
    }
    if (j.t === 'msg' && j.d && this._sharedKey) {
      try {
        const text = this._decrypt(j.d);
        this._record({ from: 'them', text });
        this._bump();
      } catch (_) {
        // bad frame, ignore
      }
      return;
    }
    if (j.t === 'bye') {
      this.close('peer closed');
      return;
    }
  }

  _record(msg) {
    msg.ts = Date.now();
    this._messages.push(msg);
    if (this._messages.length > MAX_MESSAGES_IN_MEMORY) this._messages.shift();
    this.emit('message', msg);
  }

  close(reason) {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._peerSocket && this._peerSocket.readyState === 1) {
        try { this._peerSocket.send(JSON.stringify({ t: 'bye' })); } catch (_) {}
        try { this._peerSocket.close(); } catch (_) {}
      }
    } catch (_) {}
    if (this._idleTimer) clearInterval(this._idleTimer);
    // Zeroise key material before letting it be garbage-collected.
    if (this._sharedKey) {
      this._sharedKey.fill(0);
      this._sharedKey = null;
    }
    this._privKey = null;
    this._messages = [];
    this.emit('closed', reason || 'closed');
  }

  status() {
    return {
      id: this.id,
      role: this.role,
      connected: !!(this._peerSocket && this._peerSocket.readyState === 1 && this._sharedKey),
      fingerprint: this.fingerprint,
      sharedFingerprint: this.sharedFingerprint || null,
      messageCount: this._messages.length,
      startedAt: this._startedAt,
      lastActivity: this._lastActivity,
    };
  }
}

module.exports = { BackBonesSession };
