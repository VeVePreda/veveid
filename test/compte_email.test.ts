import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * ⭐⭐ LES BANCS DU LOT 89 — l'inscription par courriel.
 *
 * ⭐ CE QU'ILS ATTRAPENT, dans l'ordre d'importance :
 *   1. Une migration qui PERD des lignes, ou qui laisse la table dans
 *      l'ancienne forme en disant que tout va bien.
 *   2. Un lien de connexion REJOUABLE — le défaut qui transforme un
 *      courriel oublié en clé permanente.
 *   3. Un lien PÉRIMÉ accepté quand même.
 *   4. Un compte sans portefeuille qui ferait tomber une page.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid89-'));
after(() => rmSync(dossier, { recursive: true, force: true }));

// ═════════════════════════════════════════════════════════════════════════
// 1. LA MIGRATION, SUR UNE BASE **ANCIENNE ET PEUPLÉE**
// ═════════════════════════════════════════════════════════════════════════
/**
 * 🔴🔴 CE BANC EST LE PLUS IMPORTANT DU LOT, et il l'est POUR PLUS TARD.
 *
 * La base de production est vide aujourd'hui : la migration y est sans
 * risque, et un banc qui ne testerait que ce cas passerait au vert sans
 * rien avoir inspecté. Or ce code tournera encore le jour où il y aura des
 * comptes — et ce jour-là, personne ne relira la migration.
 *
 * On reconstitue donc ICI l'ANCIEN schéma, à la main, avec des lignes
 * dedans, et on exige que TOUT ait voyagé.
 */
test('migration : une base ancienne et peuplée conserve toutes ses lignes', () => {
  const f = join(dossier, 'ancienne.db');
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT UNIQUE NOT NULL, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);`);
  db.prepare('INSERT INTO comptes (id, wallet, verifie, verifie_le, cree_le, abonne_jusqu_a) VALUES (?,?,?,?,?,?)')
    .run('c1', '0x' + 'a'.repeat(40), 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO comptes (id, wallet, cree_le) VALUES (?,?,?)')
    .run('c2', '0x' + 'b'.repeat(40), '2026-02-02T00:00:00.000Z');
  db.close();

  process.env.DB_PATH = f;
  return import('../src/db.ts').then((m) => {
    const base = m.base();

    const colonnes = base.prepare('PRAGMA table_info(comptes)').all() as Array<{ name: string; notnull: number }>;
    const wallet = colonnes.find((c) => c.name === 'wallet')!;
    assert.equal(wallet.notnull, 0, 'wallet doit être devenu facultatif');
    assert.ok(colonnes.some((c) => c.name === 'email'), 'la colonne email doit exister');

    // ⭐ Les DEUX lignes, et leur CONTENU — pas seulement leur nombre.
    const c1 = base.prepare('SELECT * FROM comptes WHERE id=?').get('c1') as any;
    assert.equal(c1.wallet, '0x' + 'a'.repeat(40));
    assert.equal(c1.verifie, 1, 'la preuve de propriété ne doit PAS être perdue');
    assert.equal(c1.abonne_jusqu_a, '2027-01-01T00:00:00.000Z', "l'abonnement ne doit pas être perdu");
    assert.equal(c1.verifie_le, '2026-01-01T00:00:00.000Z');
    const c2 = base.prepare('SELECT * FROM comptes WHERE id=?').get('c2') as any;
    assert.equal(c2.cree_le, '2026-02-02T00:00:00.000Z');
    assert.equal((base.prepare('SELECT COUNT(*) AS n FROM comptes').get() as any).n, 2);

    // ⭐ L'unicité du portefeuille survit à la recopie.
    assert.throws(
      () => base.prepare('INSERT INTO comptes (id, wallet, cree_le) VALUES (?,?,?)').run('c3', '0x' + 'a'.repeat(40), 'x'),
      /UNIQUE|constraint/i,
      'deux comptes ne doivent pas partager un portefeuille',
    );
    // ⭐ …mais PLUSIEURS comptes sans portefeuille coexistent. C'est tout
    //    l'objet de l'index PARTIEL : sans lui, le deuxième inscrit par
    //    courriel serait refusé par une contrainte d'unicité sur NULL.
    base.prepare('INSERT INTO comptes (id, email, cree_le) VALUES (?,?,?)').run('e1', 'un@exemple.fr', 'x');
    base.prepare('INSERT INTO comptes (id, email, cree_le) VALUES (?,?,?)').run('e2', 'deux@exemple.fr', 'x');
    assert.equal((base.prepare('SELECT COUNT(*) AS n FROM comptes WHERE wallet IS NULL').get() as any).n, 2);
    // …et deux comptes ne partagent pas une adresse.
    assert.throws(
      () => base.prepare('INSERT INTO comptes (id, email, cree_le) VALUES (?,?,?)').run('e3', 'un@exemple.fr', 'x'),
      /UNIQUE|constraint/i,
    );

    // ⭐ IDEMPOTENCE : rejouée, la migration ne fait plus rien et ne casse rien.
    assert.deepEqual(m.migrer(base), [], 'une migration déjà faite doit être un non-événement');
    /**
     * ⚠️ On referme ET on rend `DB_PATH` à la base des tests suivants.
     *    Sans cette ligne, ils tournaient — sur la base migrée, par
     *    accident. Un banc qui passe pour une raison qu'il n'annonce pas
     *    ne prouve pas ce qu'il dit prouver.
     */
    m.fermer();
    process.env.DB_PATH = join(dossier, 'liens.db');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. LE LIEN DE CONNEXION
// ═════════════════════════════════════════════════════════════════════════
process.env.DB_PATH = join(dossier, 'liens.db');
const db = await import('../src/db.ts');
const lm = await import('../src/lien_magique.ts');
const av = await import('../src/avoirs.ts');
after(() => db.fermer());

test('un lien ouvre le compte une fois, et une seule', () => {
  const d = lm.demander('Preda@Exemple.FR');
  assert.ok(d.jeton, d.erreur);
  const v1 = lm.consommer(d.jeton!);
  assert.equal(v1.email, 'preda@exemple.fr', "l'adresse est normalisée en minuscules");
  /**
   * 🔴 LE BANC QUI COMPTE. Sans la consommation atomique, ce deuxième
   *    appel réussit — et un lien resté dans une boîte mail ouvre le
   *    compte pour toujours.
   */
  const v2 = lm.consommer(d.jeton!);
  assert.equal(v2.email, undefined, 'un lien déjà utilisé ne doit plus rien ouvrir');
  assert.match(v2.pourquoi!, /plus valable/);
});

test('le jeton en clair n’est PAS dans la base', () => {
  const d = lm.demander('empreinte@exemple.fr');
  const lignes = db.q<{ empreinte: string }>('SELECT empreinte FROM liens WHERE email=?', 'empreinte@exemple.fr');
  assert.equal(lignes.length, 1);
  assert.notEqual(lignes[0].empreinte, d.jeton, 'la base ne doit contenir que l’empreinte');
  assert.match(lignes[0].empreinte, /^[0-9a-f]{64}$/, 'une empreinte sha256, en hexadécimal');
});

test('un lien périmé n’ouvre rien', () => {
  const t0 = Date.now();
  const d = lm.demander('tard@exemple.fr', { maintenant: t0 });
  const trop = t0 + (lm.DUREE_MIN + 1) * 60_000;
  assert.equal(lm.consommer(d.jeton!, trop).email, undefined);
  // ⭐ Et la borne exacte : à la minute près AVANT l'expiration, ça marche.
  const d2 = lm.demander('juste@exemple.fr', { maintenant: t0 });
  assert.equal(lm.consommer(d2.jeton!, t0 + (lm.DUREE_MIN - 1) * 60_000).email, 'juste@exemple.fr');
});

test('un jeton inventé n’ouvre rien, et ne dit pas pourquoi', () => {
  const v = lm.consommer('jeton-fabrique-de-toutes-pieces');
  assert.equal(v.email, undefined);
  assert.doesNotMatch(v.pourquoi!, /inconnu|inexistant/i,
    'le message ne doit pas distinguer « inconnu » de « déjà utilisé »');
});

test('on ne peut pas harceler une adresse de liens', () => {
  const t0 = Date.now();
  for (let i = 0; i < lm.MAX_PAR_FENETRE; i++) assert.ok(lm.demander('cible@exemple.fr', { maintenant: t0 }).jeton);
  assert.equal(lm.demander('cible@exemple.fr', { maintenant: t0 }).jeton, undefined, 'la fenêtre doit se refermer');
  // ⭐ …et elle se ROUVRE. Un limiteur qui ne relâche jamais est une porte
  //    fermée définitivement sur un simple pic d'usage.
  assert.ok(lm.demander('cible@exemple.fr', { maintenant: t0 + 16 * 60_000 }).jeton);
});

test('les adresses manifestement impossibles sont refusées, les autres passent', () => {
  for (const mauvaise of ['', '   ', 'sansarobase', 'a@b', 'a b@c.fr', '@exemple.fr', 'a@.fr', 'a@fr.'])
    assert.equal(lm.adressePlausible(mauvaise), false, `« ${mauvaise} » aurait dû être refusée`);
  /**
   * ⚠️ CES ADRESSES-LÀ SONT VALIDES, et une regex « stricte » les refuse.
   *    Un banc qui ne testerait que les cas simples laisserait passer un
   *    filtre qui exclut de vraies personnes — le genre de défaut dont on
   *    n'entend jamais parler, puisque celui qu'il bloque s'en va.
   */
  for (const bonne of ['a+etiquette@exemple.fr', 'prenom.nom@sous.domaine.co.uk', "o'brien@exemple.ie", 'a_b-c@exemple-1.fr'])
    assert.equal(lm.adressePlausible(bonne), true, `« ${bonne} » aurait dû passer`);
});

// ═════════════════════════════════════════════════════════════════════════
// 3. LE COMPTE SANS PORTEFEUILLE
// ═════════════════════════════════════════════════════════════════════════
test('un compte par courriel existe, vaut member, et n’a pas de portefeuille', () => {
  const c = av.creerOuLireCompteParEmail('veveprice','membre@exemple.fr');
  assert.equal(c.wallet, null);
  assert.equal(c.email, 'membre@exemple.fr');
  assert.equal(c.verifie, 0);
  assert.equal(av.paliDe(c), 'member');
  assert.equal(av.paliDe(undefined), 'visitor');
  // Deux fois la même adresse = le même compte, pas un doublon.
  assert.equal(av.creerOuLireCompteParEmail('veveprice','MEMBRE@Exemple.fr').id, c.id);
  av.accorderAbonnement(c.id, 30);
  assert.equal(av.paliDe(av.lireCompte(c.id)!), 'crevette');
});

test('la page « Mon compte » ne tombe pas sans portefeuille', async () => {
  const { pageCompte } = await import('../src/vues.ts');
  const c = av.creerOuLireCompteParEmail('veveprice','page@exemple.fr');
  /**
   * 🔴 L'ancien `c.wallet.slice(0, 8)` levait ici. Ce n'était pas un
   *    affichage vide : c'était un 500 sur la PREMIÈRE page que voit un
   *    nouvel inscrit.
   */
  const h = pageCompte(c, [], false, undefined, null);
  assert.match(h, /Vérifier mon portefeuille VeVe/, "l'invitation doit être là");
  assert.doesNotMatch(h, /Mes collectibles/, 'rien à montrer sans portefeuille');
  assert.match(h, /page@exemple\.fr/);

  /**
   * ⭐ ET L'AUTRE BRANCHE. Un banc qui ne teste qu'un côté d'un ternaire
   *    laisse passer exactement la moitié de ce qu'il prétend couvrir :
   *    ici, la disparition silencieuse des collectibles pour ceux qui EN
   *    ONT — le seul cas qui existait avant ce lot.
   */
  av.poserPortefeuille(c.id, '0x' + 'd'.repeat(40));
  const avec = av.lireCompte(c.id)!;
  const h2 = pageCompte(avec, [{ mint_key: 'X:1', nom: 'Objet X', edition: 1, rarete: 'RARE', image: null, vu_le: 'x' }],
    false, undefined, null);
  assert.match(h2, /Mes collectibles/);
  assert.match(h2, /Objet X/);
  assert.match(h2, /Relire la chaîne/);
  assert.doesNotMatch(h2, /Vérifier mon portefeuille VeVe/, 'l’invitation disparaît une fois le portefeuille posé');
});

test('un portefeuille abandonné ne réserve rien, un portefeuille détenu si', () => {
  const w = '0x' + 'c'.repeat(40);
  const trace = av.creerOuLireCompte('veveprice', w);                 // ancienne porte : ligne sans preuve
  const membre = av.creerOuLireCompteParEmail('veveprice','lieur@exemple.fr');
  assert.equal(av.portefeuilleOccupe('veveprice', w, membre.id), false, 'une trace abandonnée n’appartient à personne');
  av.poserPortefeuille(membre.id, w);
  assert.equal(av.lireCompte(membre.id)!.wallet, w);
  assert.equal(av.lireCompte(trace.id)!.wallet, null, 'la trace a cédé la place');
  /** ⛔ Poser n'est PAS prouver. */
  assert.equal(av.lireCompte(membre.id)!.verifie, 0);

  const autre = av.creerOuLireCompteParEmail('veveprice','autre@exemple.fr');
  assert.equal(av.portefeuilleOccupe('veveprice', w, autre.id), true, 'un portefeuille tenu par un compte avec e-mail est pris');
});

// ═════════════════════════════════════════════════════════════════════════
// 4. L'ENVOI
// ═════════════════════════════════════════════════════════════════════════
test('l’envoi rend un verdict au lieu de lever, et parle le langage de Brevo', async () => {
  const { envoyer, courrielDeConnexion } = await import('../src/courriel.ts');
  const m = courrielDeConnexion('a@exemple.fr', 'https://id.exemple/entrer-par-lien?j=XYZ', 15, true);
  assert.match(m.texte, /XYZ/, 'le lien doit être lisible dans la version texte');
  assert.match(m.html, /XYZ/);
  assert.match(m.texte, /15 minutes/);

  process.env.BREVO_CLE = 'xkeysib-essai';
  delete process.env.COURRIEL_SIMULE;

  // ⭐ 201, pas 200 : c'est ce que Brevo rend en cas de succès.
  let vu: any = null;
  const ok = await envoyer(m, (async (u: any, o: any) => {
    vu = { u, corps: JSON.parse(o.body), cle: o.headers['api-key'] };
    return new Response(JSON.stringify({ messageId: '<abc@brevo>' }), { status: 201 });
  }) as any);
  assert.equal(ok.ok, true, 'un 201 est un succès');
  assert.equal(ok.id, '<abc@brevo>');
  assert.equal(vu.u, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(vu.cle, 'xkeysib-essai');
  assert.equal(vu.corps.to[0].email, 'a@exemple.fr');
  assert.ok(vu.corps.textContent && vu.corps.htmlContent, 'texte ET html, pour la réputation d’envoi');

  // Une erreur de Brevo est rapportée AVEC SA PHRASE, pas traduite en booléen.
  const ko = await envoyer(m, (async () =>
    new Response('{"message":"Sender not valid"}', { status: 400 })) as any);
  assert.equal(ko.ok, false);
  assert.match(ko.pourquoi!, /Sender not valid/);

  // Un réseau en panne ne fait pas tomber la route.
  const panne = await envoyer(m, (async () => { throw new Error('ECONNRESET'); }) as any);
  assert.equal(panne.ok, false);
  assert.match(panne.pourquoi!, /ECONNRESET/);

  // ⛔ Sans clé et sans autorisation explicite, on échoue FERMÉ.
  delete process.env.BREVO_CLE;
  const sansCle = await envoyer(m, (async () => { throw new Error('ne doit pas être appelé'); }) as any);
  assert.equal(sansCle.ok, false);
  assert.match(sansCle.pourquoi!, /BREVO_CLE/);
});
