import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ⭐⭐ LES BANCS DU LOT 90 — les sessions servies à veveprice.
 *
 * ⭐ CE QU'ILS ATTRAPENT :
 *   1. Un code d'échange REJOUABLE — deux sessions pour un seul passage,
 *      dont une que personne ne saurait avoir laissée ouverte.
 *   2. Un palier FIGÉ dans la session : un abonnement expiré qui continue
 *      d'ouvrir jusqu'à la fin du mois.
 *   3. Une révocation qui n'en est pas une.
 *   4. Un compte en cours de suppression qui reste connecté.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid90-'));
process.env.DB_PATH = join(dossier, 'id.db');

const db = await import('../src/db.ts');
const av = await import('../src/avoirs.ts');
const ss = await import('../src/sessions.ts');
const lm = await import('../src/lien_magique.ts');
after(() => { db.fermer(); rmSync(dossier, { recursive: true, force: true }); });

const compteNeuf = (mail: string) => av.creerOuLireCompteParEmail(mail);

test('un code d’échange ouvre une session, une fois et une seule', () => {
  const c = compteNeuf('echange@exemple.fr');
  const code = ss.creerCode(c.id);
  const e = ss.echanger(code);
  assert.ok(e.sid, e.pourquoi);
  assert.equal(e.compte, c.id);
  assert.equal(e.palier, 'member');
  /**
   * 🔴 LE BANC QUI COMPTE. Sans la consommation atomique, ce deuxième
   *    appel rend un SECOND sid valide — une session ouverte que la
   *    personne n'a jamais demandée et ne verra jamais fermer.
   */
  const bis = ss.echanger(code);
  assert.equal(bis.sid, undefined, 'un code déjà échangé n’ouvre plus rien');
});

test('un code périmé n’ouvre rien — soixante secondes, pas une de plus', () => {
  const c = compteNeuf('tard@exemple.fr');
  const t0 = Date.now();
  const code = ss.creerCode(c.id, t0);
  assert.equal(ss.echanger(code, t0 + (ss.DUREE_CODE_S + 1) * 1000).sid, undefined);
  const code2 = ss.creerCode(c.id, t0);
  assert.ok(ss.echanger(code2, t0 + (ss.DUREE_CODE_S - 1) * 1000).sid, 'la borne AVANT doit passer');
});

test('un code inventé n’ouvre rien', () => {
  assert.equal(ss.echanger('code-fabrique-de-toutes-pieces').sid, undefined);
  assert.equal(ss.echanger('').sid, undefined);
});

test('le sid n’est PAS dans la base — seulement son empreinte', () => {
  const c = compteNeuf('empreinte90@exemple.fr');
  const sid = ss.ouvrirSession(c.id);
  const lignes = db.q<{ empreinte: string }>('SELECT empreinte FROM sessions WHERE compte_id=?', c.id);
  assert.equal(lignes.length, 1);
  assert.notEqual(lignes[0].empreinte, sid);
  assert.match(lignes[0].empreinte, /^[0-9a-f]{64}$/);
});

/**
 * 🔴🔴 LE BANC LE PLUS IMPORTANT DE CE FICHIER.
 *
 * La tentation, en écrivant une table de sessions, est d'y ranger le
 * palier « pour éviter une jointure ». Ce banc existe pour que ce soit
 * impossible sans le voir : on ouvre une session à `member`, on accorde
 * l'abonnement APRÈS, et on exige que la même session vaille `crevette`.
 * Puis on le fait périmer, et on exige qu'elle redescende.
 */
test('le palier se RECALCULE à chaque lecture, il n’est pas figé dans la session', () => {
  const c = compteNeuf('palier@exemple.fr');
  const sid = ss.ouvrirSession(c.id);
  assert.equal(ss.etatDeLaSession(sid).palier, 'member');

  av.accorderAbonnement(c.id, 30);
  assert.equal(ss.etatDeLaSession(sid).palier, 'crevette',
    'un abonnement pris après l’ouverture doit valoir tout de suite');

  // Un abonnement échu : la porte se referme à la requête suivante,
  // sans qu'on ait eu à parcourir la moindre session.
  db.run('UPDATE comptes SET abonne_jusqu_a=? WHERE id=?', '2020-01-01T00:00:00.000Z', c.id);
  assert.equal(ss.etatDeLaSession(sid).palier, 'member',
    'un abonnement expiré ne doit plus ouvrir — même session, même cookie');
});

test('une session révoquée est morte, et le rester ne coûte rien', () => {
  const c = compteNeuf('revoque@exemple.fr');
  const sid = ss.ouvrirSession(c.id);
  assert.ok(ss.etatDeLaSession(sid).palier);
  assert.equal(ss.revoquer(sid), true);
  assert.equal(ss.etatDeLaSession(sid).palier, undefined);
  assert.equal(ss.revoquer(sid), false, 'révoquer deux fois ne doit pas mentir sur le résultat');
});

test('une session périmée n’ouvre rien', () => {
  const c = compteNeuf('perime@exemple.fr');
  const t0 = Date.now();
  const sid = ss.ouvrirSession(c.id, t0);
  const tard = t0 + (ss.DUREE_SESSION_J + 1) * 86_400_000;
  assert.equal(ss.etatDeLaSession(sid, tard).palier, undefined);
});

test('un sid inventé n’ouvre rien, et ne fait pas tomber la lecture', () => {
  assert.deepEqual(ss.etatDeLaSession('rien-du-tout'), {});
  assert.deepEqual(ss.etatDeLaSession(''), {});
});

/**
 * ⭐ Le délai de grâce sert à REVENIR sur sa décision, pas à continuer
 *    d'utiliser le service en attendant l'effacement.
 */
test('un compte dont la suppression est demandée ne porte plus de session', () => {
  const c = compteNeuf('parti@exemple.fr');
  const sid = ss.ouvrirSession(c.id);
  assert.ok(ss.etatDeLaSession(sid).palier);
  av.demanderSuppression(c.id);
  assert.equal(ss.etatDeLaSession(sid).palier, undefined);
  // …et il redevient joignable s'il annule.
  av.annulerSuppression(c.id);
  assert.ok(ss.etatDeLaSession(sid).palier, 'annuler la suppression rouvre ce qui était ouvert');
});

test('revoquerTout ferme toutes les sessions d’un compte, et d’un seul', () => {
  const a = compteNeuf('tout-a@exemple.fr');
  const b = compteNeuf('tout-b@exemple.fr');
  const s1 = ss.ouvrirSession(a.id), s2 = ss.ouvrirSession(a.id), s3 = ss.ouvrirSession(b.id);
  assert.equal(ss.revoquerTout(a.id), 2);
  assert.equal(ss.etatDeLaSession(s1).palier, undefined);
  assert.equal(ss.etatDeLaSession(s2).palier, undefined);
  assert.ok(ss.etatDeLaSession(s3).palier, 'le compte d’à côté ne doit pas être touché');
});

// ═════════════════════════════════════════════════════════════════════════
// Le retour porté par le lien de connexion
// ═════════════════════════════════════════════════════════════════════════

test('le lien mémorise où renvoyer la personne, et le rend à la consommation', () => {
  const d = lm.demander('retour@exemple.fr', { retour: 'https://veveprice.com/compte/' });
  assert.ok(d.jeton, d.erreur);
  const v = lm.consommer(d.jeton!);
  assert.equal(v.email, 'retour@exemple.fr');
  assert.equal(v.retour, 'https://veveprice.com/compte/');
});

test('sans retour, la personne reste chez veveid — et c’est null, pas une chaîne vide', () => {
  const d = lm.demander('sansretour@exemple.fr');
  assert.equal(lm.consommer(d.jeton!).retour, null);
});

/**
 * 🔴 CE BANC EST NÉ D'UN BANC ROUGE. La première version de `demander()`
 *    prenait `(email, retour, maintenant)` ; les appels existants en
 *    `(email, t0)` rangeaient un TIMESTAMP dans le champ qui décide où la
 *    personne est renvoyée. Silencieusement.
 *
 * ⭐⭐ Un paramètre ajouté au milieu d'une signature ne casse pas les
 *     appels : il les DÉCALE. Les options nommées rendent la faute
 *     impossible à écrire ; ce garde-ci la rend impossible à ignorer.
 */
test('un retour qui n’est pas une adresse est REFUSÉ, bruyamment', () => {
  for (const mauvais of [String(Date.now()), 'chez-moi', 'javascript:alert(1)', 'ftp://x.fr'])
    assert.match(lm.demander('garde@exemple.fr', { retour: mauvais }).erreur ?? '', /illisible/,
      `« ${mauvais} » aurait dû être refusé`);
  assert.ok(lm.demander('garde@exemple.fr', { retour: 'https://veveprice.com/x' }).jeton);
});

test('le ménage efface le périmé et garde la trace récente d’une révocation', () => {
  const c = compteNeuf('menage@exemple.fr');
  const t0 = Date.now();
  const vif = ss.ouvrirSession(c.id, t0);
  const mort = ss.ouvrirSession(c.id, t0 - (ss.DUREE_SESSION_J + 2) * 86_400_000);
  ss.purgerSessions(t0);
  assert.equal(db.q('SELECT 1 FROM sessions WHERE compte_id=?', c.id).length, 1, 'le périmé part');
  assert.ok(ss.etatDeLaSession(vif, t0).palier, 'le vivant reste');
  assert.equal(ss.etatDeLaSession(mort, t0).palier, undefined);
});

// ═════════════════════════════════════════════════════════════════════════
// Les garde-fous anti-robots (lot 95)
// ═════════════════════════════════════════════════════════════════════════
const rb = await import('../src/robots.ts');

test('un formulaire posté trop vite est écarté, un formulaire lu ne l’est pas', () => {
  const t0 = Date.now();
  const s = rb.sceau(t0);
  assert.equal(rb.verdict('', s, t0 + 500).ok, false, 'un robot poste dans la seconde');
  assert.equal(rb.verdict('', s, t0 + rb.DELAI_MIN_MS + 1).ok, true, 'un humain met plus de temps');
  /** ⚠️ Et la borne HAUTE : un sceau récolté une fois ne doit pas ouvrir mille fois. */
  assert.equal(rb.verdict('', s, t0 + rb.DELAI_MAX_MS + 1).ok, false, 'un sceau périmé n’est pas un laissez-passer');
});

test('le champ piège désigne son robot', () => {
  const s = rb.sceau(Date.now() - 5000);
  assert.equal(rb.verdict('http://spam.example', s).ok, false);
  assert.equal(rb.verdict('   ', s).ok, true, 'un champ vide d’espaces reste vide');
  assert.equal(rb.verdict(null, s).ok, true);
  assert.equal(rb.verdict(undefined, s).ok, true);
});

/**
 * 🔴 LE BANC QUI COMPTE. Sans signature, il suffirait de poster un horodatage
 *    vieux de dix secondes : le contrôle ne coûterait RIEN à contourner et
 *    donnerait l'illusion d'une protection.
 */
test('un sceau forgé ou trafiqué n’ouvre rien', () => {
  const t0 = Date.now();
  const vrai = rb.sceau(t0 - 5000);
  assert.equal(rb.verdict('', `${t0 - 5000}.nimportequoi`).ok, false, 'signature inventée');
  assert.equal(rb.verdict('', '').ok, false, 'sceau absent');
  assert.equal(rb.verdict('', 'pas-de-point').ok, false);
  // ⭐ On change l'horodatage en gardant la signature : elle ne colle plus.
  const [, sig] = vrai.split('.');
  assert.equal(rb.verdict('', `${t0 - 999_999}.${sig}`).ok, false, 'horodatage rejoué');
});

test('l’adresse relayée n’est lue que si elle ressemble à une adresse', () => {
  assert.equal(rb.adresseRelayee('203.0.113.7'), '203.0.113.7');
  assert.equal(rb.adresseRelayee('203.0.113.7, 10.0.0.1'), '203.0.113.7', 'on prend la première');
  assert.equal(rb.adresseRelayee('2001:db8::1'), '2001:db8::1');
  for (const mauvais of ['', null, undefined, 42, 'pas une adresse', 'a'.repeat(60), '<script>'])
    assert.equal(rb.adresseRelayee(mauvais as any), null, `« ${mauvais} » aurait dû être écarté`);
});

/**
 * ⭐⭐ CE BANC EXISTE POUR LA TRACE EXPOSÉE PUBLIQUEMENT. `/sante` sert
 *    `dernier` à qui le demande : une adresse ou une clé qui s'y glisserait
 *    serait une fuite, pas une gêne.
 */
test('la trace du dernier envoi masque les adresses et les clés', async () => {
  const co = await import('../src/courriel.ts');
  co.oublierDernierEnvoi();
  assert.equal(co.dernierEnvoi(), null, 'rien tant que rien n’est parti');
  process.env.BREVO_CLE = 'xkeysib-secret';
  delete process.env.COURRIEL_SIMULE;
  const m = co.courrielDeConnexion('preda@exemple.fr', 'https://x/l?j=1', 15, true);
  await co.envoyer(m, (async () => new Response(
    '{"message":"sender preda@exemple.fr invalid, key xkeysib-abc"}', { status: 400 })) as any);
  const t = co.dernierEnvoi()!;
  assert.equal(t.ok, false);
  assert.doesNotMatch(t.pourquoi!, /preda@exemple\.fr/, 'aucune adresse ne doit sortir');
  assert.doesNotMatch(t.pourquoi!, /xkeysib-abc/, 'aucune clé ne doit sortir');
  assert.match(t.pourquoi!, /Brevo 400/, '…mais le motif doit rester lisible');
  assert.match(t.pourquoi!, /invalid/);
  delete process.env.BREVO_CLE;
});
