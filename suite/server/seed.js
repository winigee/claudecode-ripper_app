// Demo data so the prototype opens looking like a working firm.
// Run automatically on first boot (empty db), or `npm run seed -- --force`.

const db = require('./db');

function seed({ force = false } = {}) {
  db.load();
  if (!force && db.all('matters').length > 0) return false;
  if (force) db.reset();

  const acme = db.insert('clients', {
    name: 'Acme Robotics Ltd', type: 'organization',
    email: 'legal@acmerobotics.example', phone: '+1 415 555 0142',
    address: '500 Innovation Way, San Jose, CA 95110',
  });
  const jane = db.insert('clients', {
    name: 'Jane Whitcombe', type: 'individual',
    email: 'jane.whitcombe@example.com', phone: '+44 20 7946 0958',
    address: '14 Elm Crescent, London, SW1A 1AA',
  });
  const meridian = db.insert('clients', {
    name: 'Meridian Property Holdings LLC', type: 'organization',
    email: 'ops@meridianproperty.example', phone: '+1 212 555 0177',
    address: 'PO Box 4471, New York, NY 10001',
  });

  const m1 = db.insert('matters', {
    title: 'Acme Robotics v. Nexus Components — breach of supply contract',
    reference: 'M-100231', clientId: acme.id, practiceArea: 'Commercial Litigation',
    status: 'open', responsibleAttorney: 'Sarah Okonkwo',
    description: 'Dispute over defective servo motors delivered under a 3-year supply agreement. Acme seeks damages and contract termination.',
    parties: [
      { name: 'Nexus Components Inc', role: 'Defendant', type: 'organization' },
      { name: 'Dr Alan Pierce', role: 'Expert witness (engineering)', type: 'individual' },
    ],
    tags: ['litigation', 'contract'],
  });
  const m2 = db.insert('matters', {
    title: 'Whitcombe — residential conveyancing, 14 Elm Crescent',
    reference: 'M-100245', clientId: jane.id, practiceArea: 'Real Estate',
    status: 'open', responsibleAttorney: 'David Mensah',
    description: 'Purchase of freehold residential property. Exchange targeted for next month.',
    parties: [{ name: 'Hartwell & Co Estate Agents', role: 'Seller agent', type: 'organization' }],
    tags: ['conveyancing'],
  });
  const m3 = db.insert('matters', {
    title: 'Meridian — commercial lease renegotiation (Tower 9)',
    reference: 'M-100250', clientId: meridian.id, practiceArea: 'Real Estate',
    status: 'pending', responsibleAttorney: 'Sarah Okonkwo',
    description: 'Renegotiating anchor-tenant lease terms ahead of a 2027 break clause.',
    parties: [], tags: ['commercial', 'lease'],
  });

  db.insert('documents', {
    matterId: m1.id, name: 'Supply Agreement (executed).pdf', type: 'contract',
    source: 'uploaded', tags: ['contract', 'key'],
    content:
`SUPPLY AGREEMENT between Acme Robotics Ltd and Nexus Components Inc, dated 3 March 2023.
Clause 7.2: Defects must be notified within 30 days of delivery.
Clause 11: Either party may terminate for material breach not cured within 45 days of written notice.
Clause 14: Any claim must be brought within 12 months of the cause of action arising.
Delivery of the disputed consignment was accepted on 12 January 2026.
A notice of material breach was served on Nexus Components Inc on 5 February 2026.`,
  });
  db.insert('documents', {
    matterId: m1.id, name: 'Letter from Nexus counsel.txt', type: 'correspondence',
    source: 'uploaded', tags: ['correspondence'],
    content:
`From: counsel@nexuscomponents.example
We dispute any breach. Our client requires Acme's particulars of claim within 21 days.
A case management hearing has been listed for 18 August 2026 at the Commercial Court.`,
  });

  db.insert('events', {
    matterId: m1.id, title: 'Serve particulars of claim', dueDate: addDays(14),
    type: 'filing', priority: 'high', status: 'pending', source: 'manual',
  });
  db.insert('events', {
    matterId: m1.id, title: 'Case management hearing — Commercial Court', dueDate: '2026-08-18',
    type: 'hearing', priority: 'high', status: 'pending', source: 'manual',
  });
  db.insert('events', {
    matterId: m2.id, title: 'Target exchange of contracts', dueDate: addDays(28),
    type: 'deadline', priority: 'normal', status: 'pending', source: 'manual',
  });

  db.insert('notes', { matterId: m1.id, body: 'Client wants an aggressive posture but is open to settlement above $400k.', author: 'Sarah Okonkwo' });

  db.insert('timeEntries', { matterId: m1.id, attorney: 'Sarah Okonkwo', minutes: 90, rate: 450, description: 'Review supply agreement and breach notice', date: today() });
  db.insert('timeEntries', { matterId: m2.id, attorney: 'David Mensah', minutes: 45, rate: 320, description: 'Initial title review', date: today() });

  db.insert('intake', {
    from: 'r.delgado@example.com', fromName: 'Roberto Delgado',
    subject: 'Slip and fall at Meridian-owned mall — possible claim',
    body: 'I was injured last Tuesday at the Tower 9 shopping centre when I slipped on an unmarked wet floor. I had to go to the ER. I want to understand my options. This is fairly urgent as I am losing income.',
    status: 'new', receivedAt: today(),
  });
  db.insert('intake', {
    from: 'legal@acmerobotics.example', fromName: 'Acme Legal',
    subject: 'Re: Nexus dispute — new evidence',
    body: 'We found internal QA emails from Nexus admitting the servo defect. Can we get these to you before the particulars deadline?',
    status: 'new', receivedAt: today(),
  });
  db.insert('intake', {
    from: 'winner@prize-claims.example', fromName: 'Claims Dept',
    subject: 'YOU HAVE WON $5,000,000 — claim now',
    body: 'Click here to claim your prize. Send your bank details to release funds.',
    status: 'new', receivedAt: today(),
  });

  db.flush();
  return true;
}

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

if (require.main === module) {
  const force = process.argv.includes('--force');
  const did = seed({ force });
  console.log(did ? 'Seeded demo data.' : 'Database already populated (use --force to reseed).');
}

module.exports = { seed };
