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
 *
 * ⭐ LOT 141 — un cinquième, et il ne regarde plus une destination mais
 *   TOUTES : une destination qui ne correspond à AUCUNE route servie.
 *   Le détail est au pied du fichier ; ce qu'il faut retenir ici, c'est
 *   que la liste s'allonge et que le contrôle ne s'allonge pas avec elle.
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid99-'));
process.env.DB_PATH = join(dossier, 'id.db');

const db = await import('../src/db.ts');
const av = await import('../src/avoirs.ts');
const rl = await import('../src/relais.ts');
after(() => { db.fermer(); rmSync(dossier, { recursive: true, force: true }); });

test('un jeton de relais fait entrer, une fois et une seule', () => {
  const c = av.creerOuLireCompteParEmail('veveprice','relais@exemple.fr');
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
  const c = av.creerOuLireCompteParEmail('veveprice','relais2@exemple.fr');
  const p = rl.consommerRelais(rl.creerRelais(c.id, 'verifier')!);
  assert.equal(p.chemin, '/choisir');
});

/**
 * 🔥 LOT 141 — LE RACCOURCI VERS LE PARCOURS SANS ADRESSE.
 *
 * ⭐⭐ CE QU'IL RETIRE : deux clics et deux redirections. Depuis `/compte/`
 *   sur veveprice, le bouton envoyait `verifier` ⇒ `/choisir`, qui renvoie
 *   de lui-même vers `/compte` quand il n'y a pas encore de portefeuille —
 *   et là il fallait RE-CLIQUER pour atteindre `/decouvrir`. La page qu'on
 *   venait de promettre était à deux pages de la promesse.
 *
 * ⚠️ `verifier` N'EST PAS REMPLACÉE, elle reste : un membre qui a déjà son
 *    adresse doit continuer d'aller droit au parcours de preuve. Ce sont
 *    deux parcours, pas deux versions du même.
 */
test('⭐ la destination « decouvrir » mène au parcours SANS adresse', () => {
  const c = av.creerOuLireCompteParEmail('veveprice','relais6@exemple.fr');
  const p = rl.consommerRelais(rl.creerRelais(c.id, 'decouvrir')!);
  assert.equal(p.chemin, '/decouvrir',
    'sans portefeuille, on entre directement sur la page qui ne demande pas d’adresse');
});

test('🔴 une destination inconnue est REFUSÉE — pas de redirection ouverte', () => {
  const c = av.creerOuLireCompteParEmail('veveprice','relais3@exemple.fr');
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
  const c = av.creerOuLireCompteParEmail('veveprice','relais4@exemple.fr');
  const t0 = Date.now();
  const jeton = rl.creerRelais(c.id, 'compte', t0)!;
  const tard = t0 + (rl.DUREE_RELAIS_S + 1) * 1000;
  assert.equal(rl.consommerRelais(jeton, tard).compteId, undefined);
});

test('le jeton n’est pas stocké en clair — une base lue ne fait entrer personne', () => {
  const c = av.creerOuLireCompteParEmail('veveprice','relais5@exemple.fr');
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

// ═════════════════════════════════════════════════════════════════════════
// 🔥 LOT 141 — UNE DESTINATION QUI NE MÈNE NULLE PART
// ═════════════════════════════════════════════════════════════════════════
/**
 * ⭐⭐⭐ UN INVARIANT, PAS UNE SECONDE LISTE.
 *
 * La tentation, en ajoutant `decouvrir`, était d'écrire un test de plus :
 * « `decouvrir` mène à `/decouvrir` ». Il y en a un, juste au-dessus, et il
 * ne prouve qu'une chose — que la table dit ce qu'elle dit. Il serait vert
 * si `/decouvrir` n'était servie par personne.
 *
 * Or c'est exactement la panne qu'on redoute : le relais consomme le
 * jeton, pose le cookie, redirige — et le serveur répond par un renvoi
 * vers l'accueil. La personne est bien connectée, et elle atterrit au
 * point de départ. Aucune erreur, aucun journal, rien à chercher.
 *
 * ⭐ Ce contrôle porte donc sur TOUTE la table, présente et à venir. Une
 *   quatrième destination ajoutée dans six mois sera réclamée sans que
 *   personne ait à y penser — c'est le seul genre de contrôle qui survit
 *   à l'oubli.
 */
test('🔴 CHAQUE destination du relais est une route RÉELLEMENT servie', () => {
  const src = readFileSync(join(RACINE, 'server.ts'), 'utf-8');

  /**
   * ⭐ AUTO-CONTRÔLE D'ABORD, ET IL NE VIEILLIT PAS. Ce banc reconnaît une
   *   route à la forme `p === '/xxx'`. Le jour où `server.ts` est réécrit
   *   avec un routeur, cette forme disparaît : la boucle ci-dessous
   *   déclarerait alors TOUT manquant — ou, pire, si on l'écrivait à
   *   l'envers, tout présent. On vérifie donc que l'instrument voit encore
   *   quelque chose, sans figer un COMPTE qu'il faudrait penser à relever.
   */
  assert.match(src, /p === '\/[a-z-]+'/,
    'ce banc ne sait plus reconnaître une route : il ne contrôle plus rien');

  const chemins = Object.entries(rl.DESTINATIONS);
  assert.ok(chemins.length > 0, 'une table de destinations vide ne se contrôle pas');

  for (const [nom, chemin] of chemins)
    assert.ok(src.includes(`p === '${chemin}'`),
      `la destination « ${nom} » mène à « ${chemin} », que AUCUNE route de server.ts ne sert. `
      + 'Le relais ferait entrer la personne, puis la renverrait à l’accueil — sans une erreur.');
});

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
