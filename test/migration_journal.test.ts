// ⚠️ DEPOT : VeVePreda/veveid   ·   CHEMIN : test/migration_journal.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 🔥 LOT 108 — CE QUE LA BASE DOIT SAVOIR DIRE D'ELLE-MÊME.
 *
 * ⛔ Ce fichier ne rejoue PAS la migration du lot 107 : `isolation_site.test.ts`
 *    la couvre déjà, sur la forme exacte de la production, et par l'ÉCRITURE.
 *    Le redoubler donnerait deux bancs qui tombent ensemble et qui se
 *    croiraient deux preuves.
 *
 * Ici, trois choses NEUVES et seulement elles :
 *   ② un échec de construction ne se mémorise pas ;
 *   ③ le journal de migration survit à la fermeture ;
 *   ⑤ la sonde ne rend que des booléens.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-108-'));
after(() => rmSync(dossier, { recursive: true, force: true }));

/** La forme d'avant le lot 107, comme en production. */
function baseDeProduction(nom: string): string {
  const f = join(dossier, nom);
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);
  CREATE UNIQUE INDEX idx_comptes_wallet ON comptes(wallet) WHERE wallet IS NOT NULL;
  CREATE UNIQUE INDEX idx_comptes_email ON comptes(email) WHERE email IS NOT NULL;`);
  db.prepare('INSERT INTO comptes (id, wallet, email, verifie, cree_le) VALUES (?,?,?,?,?)')
    .run('juillet', '0x' + '1'.repeat(40), 'preda@exemple.net', 1, '2026-07-18T00:00:00.000Z');
  db.close();
  return f;
}

// ═══════════════════════════════════════════════════════════════════════
// ③ LE JOURNAL EST UN ÉTAT, PAS UN ÉVÉNEMENT
// ═══════════════════════════════════════════════════════════════════════
test('🔴 le journal de migration survit à la fermeture de la base', async () => {
  const f = baseDeProduction('journal.db');
  process.env.DB_PATH = f;
  process.env.SITE_DEFAUT = 'veveprice';
  const m = await import('../src/db.ts');

  m.base();
  m.fermer();
  // ⭐ ON ROUVRE. C'est TOUT le banc : un `console.log` n'aurait pas
  //    traversé cette ligne. Le 07/08, la preuve vivait dans un flux qui
  //    défile — et on a cherché dedans une ligne pas encore écrite.
  const db = m.base();
  const lignes = db.prepare("SELECT cle, valeur FROM reglages WHERE cle LIKE 'migration.%' ORDER BY cle")
    .all() as Array<{ cle: string; valeur: string }>;

  assert.ok(lignes.length >= 3, `le journal doit être relisible après réouverture (${lignes.length} ligne(s))`);
  assert.ok(lignes.some((l) => l.valeur.includes('colonne site ajoutee')));
  assert.ok(lignes.some((l) => l.valeur.includes('idx_comptes_wallet')));

  // ⚠️ Le rang est sur deux chiffres : le tri lexicographique des clés doit
  //    rendre le journal dans l'ORDRE où il a été écrit.
  assert.deepEqual([...lignes].map((l) => l.cle).sort(), lignes.map((l) => l.cle),
    'les clés doivent se trier dans l\'ordre chronologique');

  // ⛔ Et rien d'autre que le journal : aucune adresse n'a le droit d'être là.
  const tout = lignes.map((l) => l.valeur).join(' ');
  assert.ok(!tout.includes('@'), 'aucune adresse e-mail dans le journal');
  assert.ok(!tout.includes('0x'), 'aucun portefeuille dans le journal');
  m.fermer();
});

test('⭐ le dernier démarrage est réécrit à CHAQUE ouverture', async () => {
  const f = baseDeProduction('demarrage.db');
  process.env.DB_PATH = f;
  const m = await import('../src/db.ts');
  const lire = () => (m.base().prepare("SELECT valeur FROM reglages WHERE cle='base.dernier_demarrage'")
    .get() as { valeur: string } | undefined)?.valeur;

  const un = lire();
  assert.ok(un, 'la première ouverture doit laisser une trace');
  m.fermer();
  await new Promise((r) => setTimeout(r, 5));
  const deux = lire();
  m.fermer();
  assert.notEqual(deux, un, 'la seconde ouverture réécrit la trace — c\'est la seule ÉCRITURE du démarrage');
});

// ═══════════════════════════════════════════════════════════════════════
// ② UN ÉCHEC DE CONSTRUCTION NE SE MÉMORISE PAS
// ═══════════════════════════════════════════════════════════════════════
/**
 * ⭐⭐⭐ LE BANC QUI MANQUAIT. Avant le lot 108, `_db` était affecté AVANT la
 * migration : une migration qui levait rendait 500 **une seule fois**, puis
 * `if (_db) return _db;` servait une base restée à l'ancienne forme, sans
 * erreur, indéfiniment. Une panne bruyante qui ne l'est qu'une fois est une
 * panne muette.
 *
 * ⚠️ ON SIMULE PAR L'ÉCRITURE, ET C'EST LE BON CHOIX : une table `reglages`
 *    à la mauvaise forme fait échouer `consigner()`, exactement comme le
 *    ferait un volume monté en LECTURE SEULE — la panne réelle qu'on veut
 *    rendre bruyante au démarrage. Le banc et l'incident qu'il prévient ont
 *    la même forme.
 */
test('🔴 une base qui ne peut pas s\'ouvrir échoue AUSSI la deuxième fois', async () => {
  const f = join(dossier, 'cassee.db');
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE comptes (
    id TEXT PRIMARY KEY, wallet TEXT, email TEXT, verifie INTEGER NOT NULL DEFAULT 0,
    verifie_le TEXT, cree_le TEXT NOT NULL, abonne_jusqu_a TEXT, supprime_le TEXT);
  -- ⛔ Une colonne, là où le schéma en attend trois : l'écriture du journal
  --    ne peut pas aboutir. C'est notre « volume en lecture seule ».
  CREATE TABLE reglages (cle TEXT PRIMARY KEY);`);
  db.close();

  process.env.DB_PATH = f;
  const m = await import('../src/db.ts');
  m.fermer();

  assert.throws(() => m.base(), 'la première ouverture doit échouer');
  // ⭐ C'EST CETTE LIGNE QUI EST LE BANC. Sans le lot 108 elle passait :
  //    la base cassée était déjà mémorisée, et cet appel rendait tout vert.
  assert.throws(() => m.base(), 'et la deuxième aussi — sinon la panne se tait');
  m.fermer();
});

// ═══════════════════════════════════════════════════════════════════════
// ⑤ LA SONDE NE DIT QUE DES BOOLÉENS
// ═══════════════════════════════════════════════════════════════════════
test('⭐ /sante ne rend que des booléens et un comptage', async () => {
  const f = baseDeProduction('sonde.db');
  process.env.DB_PATH = f;
  const db = await import('../src/db.ts');
  db.fermer();
  const a = await import('../src/admin.ts');

  const s = a.santeDeLaBase();
  assert.equal(s.ouverte, true);
  assert.equal(s.site_present, true, 'la colonne site doit être vue');
  assert.ok(s.migrations >= 3);

  // ⛔ La forme de la réponse est le banc : trois clés, pas une de plus.
  assert.deepEqual(Object.keys(s).sort(), ['migrations', 'ouverte', 'site_present']);
  assert.equal(typeof s.migrations, 'number');
  db.fermer();
});
