import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⭐⭐ LES BANCS DU LOT 99 — le relais, et la porte qu'il ne doit pas ouvrir.
 *
 * ⭐ CE QU'ILS ATTRAPENT :
 *   1. Un jeton de relais REJOUABLE — deux sessions pour un clic.
 *   2. Une destination LIBRE — c'est-à-dire une redirection ouverte qui
 *      porte notre domaine.
 *   3. Un jeton qui survit à sa minute.
 *   4. 🔴 UN BACKTICK DANS LE GABARIT SQL — le piège payé TROIS fois.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid99-'));
process.env.DB_PATH = join(dossier, 'id.db');

const db = await import('../src/db.ts');
const av = await import('../src/avoirs.ts');
const rl = await import('../src/relais.ts');
after(() => { db.fermer(); rmSync(dossier, { recursive: true, force: true }); });

test('un jeton de relais fait entrer, une fois et une seule', () => {
  const c = av.creerOuLireCompteParEmail('relais@exemple.fr');
  const jeton = rl.creerRelais(c.id, 'compte');
  assert.ok(jeton);
  const p = rl.consommerRelais(jeton!);
  assert.equal(p.compteId, c.id, p.pourquoi);
  assert.equal(p.chemin, '/compte');

  /**
   * 🔴 LE BANC QUI COMPTE. Sans la consommation atomique, ce second appel
   *    rend un second passage valide — et le jeton traîne dans
   *    l'historique du navigateur, dans les journaux du proxy, et dans le
   *    `Referer` du premier lien cliqué ensuite.
   */
  const bis = rl.consommerRelais(jeton!);
  assert.equal(bis.compteId, undefined, 'un jeton déjà consommé n’ouvre plus rien');
});

test('la destination « verifier » mène au parcours de preuve', () => {
  const c = av.creerOuLireCompteParEmail('relais2@exemple.fr');
  const p = rl.consommerRelais(rl.creerRelais(c.id, 'verifier')!);
  assert.equal(p.chemin, '/choisir');
});

test('🔴 une destination inconnue est REFUSÉE — pas de redirection ouverte', () => {
  const c = av.creerOuLireCompteParEmail('relais3@exemple.fr');
  /**
   * ⭐⭐ LA TENTATION ÉTAIT D'ACCEPTER UN CHEMIN LIBRE — « c'est le site qui
   *    sait où il envoie ». Ce serait faire de cette route une redirection
   *    ouverte AUTHENTIFIÉE : avec le secret de service, on fabriquerait un
   *    lien portant notre domaine et menant ailleurs. Le refus doit arriver
   *    à la FABRICATION, pas à la consommation : un jeton qu'on ne peut pas
   *    créer ne peut pas fuiter.
   */
  for (const mauvais of ['https://ailleurs.example/vol', '/admin', '../compte', '', 'COMPTE'])
    assert.equal(rl.creerRelais(c.id, mauvais), null, `« ${mauvais} » ne doit pas produire de jeton`);
});

test('un jeton périmé n’ouvre rien', () => {
  const c = av.creerOuLireCompteParEmail('relais4@exemple.fr');
  const t0 = Date.now();
  const jeton = rl.creerRelais(c.id, 'compte', t0)!;
  const tard = t0 + (rl.DUREE_RELAIS_S + 1) * 1000;
  assert.equal(rl.consommerRelais(jeton, tard).compteId, undefined);
});

test('le jeton n’est pas stocké en clair — une base lue ne fait entrer personne', () => {
  const c = av.creerOuLireCompteParEmail('relais5@exemple.fr');
  const jeton = rl.creerRelais(c.id, 'compte')!;
  const lignes = db.q<{ empreinte: string }>('SELECT empreinte FROM relais');
  assert.equal(lignes.some((l) => l.empreinte === jeton), false,
    'la base doit porter l’empreinte, jamais le jeton');
});

// ═════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 LE BACKTICK DANS LE GABARIT SQL — payé TROIS fois
// ═════════════════════════════════════════════════════════════════════════
/**
 * `db.ts` porte cet avertissement depuis le 20/07/2026 :
 *   « AUCUN BACKTICK dans ce gabarit : un backtick dans un commentaire SQL
 *     REFERME le template JavaScript, et l'erreur rendue parle de
 *     point-virgule. »
 * Il était juste. Il a été lu. Et le piège a quand même été repayé le
 * 06/08 en écrivant la table `relais` — parce qu'un commentaire ne
 * s'exécute pas.
 *
 * ⭐⭐⭐ UN AVERTISSEMENT QUI NE SE MESURE PAS FINIT PAR SE FAIRE LIRE SANS
 *   ÊTRE SUIVI. Celui-ci devient un capteur : il ne dit plus « faites
 *   attention », il refuse.
 *
 * ⚠️ ET SURTOUT IL NOMME LE DÉFAUT. Sans lui, le symptôme est
 *   « Expected a semicolon » sur un fichier dont la ligne fautive est
 *   ailleurs — trois fois de suite, on a cherché la ponctuation.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

test('🔴 aucun backtick dans les gabarits SQL de db.ts', () => {
  const src = readFileSync(join(RACINE, 'src', 'db.ts'), 'utf-8');
  for (const m of src.matchAll(/=\s*`([\s\S]*?)`;/g)) {
    assert.equal(m[1].includes('`'), false,
      'un backtick dans ce gabarit REFERME le template : le service ne démarre plus, '
      + 'et l’erreur parle de point-virgule au lieu de nommer la cause');
  }
  // ⭐ Auto-contrôle : si le gabarit n'est plus trouvé (renommage, refonte),
  // la boucle ci-dessus tourne à vide et déclare vert un fichier qu'elle
  // n'a pas lu. Un verdict rendu sur zéro élément n'a rien prouvé.
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS comptes'),
    'le schéma n’est plus là où ce banc le cherche — il ne contrôle plus rien');
});
