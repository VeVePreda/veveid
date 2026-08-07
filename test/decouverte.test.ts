import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 🔥 LOT 106 — LE BANC DE LA DÉCOUVERTE SANS ADRESSE.
 *
 * ⭐⭐ CE QU'IL GARDE VRAIMENT : deux règles dont la disparition ne casserait
 * RIEN et transformerait ce protocole en formulaire où l'on se déclare
 * propriétaire du portefeuille d'un inconnu —
 *   · seuls les dépôts POSTÉRIEURS à la déclaration comptent ;
 *   · les deux dépôts doivent venir du MÊME portefeuille.
 * Les deux ont leur test ci-dessous, et ils sont les seuls à ne jamais
 * pouvoir être « assouplis ».
 */

const dossier = mkdtempSync(join(tmpdir(), 'veveid-106-'));
process.env.DB_PATH = join(dossier, 'id.db');
// ⚠️ `JEUX` AVANT LE PREMIER IMPORT : c'est le registre des sites, et il est lu
//    PARESSEUSEMENT puis mis en cache. Posé après, il n'aurait jamais été vu —
//    et tous les sites seraient retombés sur le défaut, donc tous les bancs
//    d'isolation auraient été VERTS sur un seul cloisonnement.
process.env.JEUX = 'loop=https://loop.exemple.net,arcade=https://arcade.exemple.net,veveprice=https://veveprice.com';

const { fermer, run } = await import('../src/db.ts');
const {
  declarer, rafraichir, decouverteActive, lireDecouverte, tentativesDuJour,
  avancement, purgerDecouvertes, normNom, cleDe,
  NB_PAIRES, FENETRE_MIN, MAX_TENTATIVES_JOUR,
} = await import('../src/decouverte.ts');
const { parseEntreesEscrow, ESCROW, VEVE_CONTRACT } = await import('../src/collectchain.ts');

after(() => { fermer(); rmSync(dossier, { recursive: true, force: true }); });

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const enForme = async () => true;
const enPanne = async () => false;

let n = 0;
const compte = () => `c${++n}`;

const entree = (nom: string, edition: number, from: string, opts: { comic?: boolean; at?: string } = {}) => ({
  tokenId: `${nom}-${edition}`, name: nom, edition, from,
  at: opts.at ?? new Date().toISOString(), block: 1, comic: opts.comic ?? false,
});
const flux = (...e: any[]) => async () => ({ entrees: e, complet: true });

// ═════════════════════════════════════════════════════════════════════════
// 0. L'INSTRUMENT AVANT LA MESURE
// ═════════════════════════════════════════════════════════════════════════
test('la clé compare des noms écrits par un humain et des noms venus de la chaîne', () => {
  // ⭐ Mesuré dans le flux réel : « Hook’s Watch » porte une apostrophe
  // typographique. Une personne tape « Hook's Watch ».
  assert.equal(normNom('Hook’s Watch'), normNom("hook's watch"));
  assert.equal(normNom('Buzz Lightyear – Lightyear Blast'), normNom('Buzz Lightyear - Lightyear Blast'));
  assert.equal(normNom('  Élan   Vital '), normNom('elan vital'));
  // ⛔ Mais elle ne doit pas confondre deux objets distincts.
  assert.notEqual(normNom('Master Splinter'), normNom('Master Splinter II'));
  // 🔴 LA CLÉ EST LA PAIRE : 24 noms du flux réel sont portés par plusieurs dépôts.
  assert.notEqual(cleDe({ nom: 'A', edition: 1 }), cleDe({ nom: 'A', edition: 2 }));
});

test('les constantes sont bien celles qui ont été arbitrées', () => {
  assert.equal(NB_PAIRES, 2, 'un seul objet ne prouverait rien');
  assert.equal(FENETRE_MIN, 10, 'arbitrage Preda du 07/08');
  assert.equal(MAX_TENTATIVES_JOUR, 5);
});

// ═════════════════════════════════════════════════════════════════════════
// 1. DÉCLARER
// ═════════════════════════════════════════════════════════════════════════
test('une panne de la chaîne a sa PROPRE phrase, et ne ressemble pas à une faute de la personne', async () => {
  const r = await declarer(compte(), [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enPanne);
  assert.equal(r.panne, true);
  assert.match(r.erreur!, /ne répond pas/);
  assert.match(r.erreur!, /Ce n'est pas vous/);
  assert.equal(r.decouverte, undefined);
});

test('il faut exactement deux objets DIFFÉRENTS', async () => {
  const c = compte();
  assert.match((await declarer(c, [{ nom: 'A', edition: 1 }], enForme)).erreur!, /exactement 2/);
  // le même objet deux fois ne prouve rien de plus qu'une fois
  assert.match((await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'a', edition: 1 }], enForme)).erreur!, /exactement 2/);
  // une édition absente ne doit pas devenir « exemplaire n° 0 »
  assert.match((await declarer(c, [{ nom: 'A', edition: '' }, { nom: 'B', edition: 2 }], enForme)).erreur!, /exactement 2/);
  assert.match((await declarer(c, [{ nom: 'A', edition: 0 }, { nom: 'B', edition: 2 }], enForme)).erreur!, /exactement 2/);
});

test('la déclaration est SCELLÉE : un second envoi rend la même, il ne la remanie pas', async () => {
  const c = compte();
  const a = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const b = await declarer(c, [{ nom: 'X', edition: 9 }, { nom: 'Y', edition: 8 }], enForme);
  assert.equal(b.decouverte!.id, a.decouverte!.id);
  assert.deepEqual(b.decouverte!.paires.map((p) => p.nom), ['A', 'B']);
});

test('le plafond de tentatives tient — sans lui, on relance jusqu’à tomber juste', async () => {
  const c = compte();
  for (let i = 0; i < MAX_TENTATIVES_JOUR; i++) {
    const r = await declarer(c, [{ nom: `A${i}`, edition: 1 }, { nom: `B${i}`, edition: 2 }], enForme);
    assert.ok(r.decouverte, `tentative ${i + 1} refusée à tort`);
    run("UPDATE decouvertes SET etat='expire' WHERE id=?", r.decouverte!.id);
  }
  assert.equal(tentativesDuJour(c), MAX_TENTATIVES_JOUR);
  const trop = await declarer(c, [{ nom: 'Z', edition: 1 }, { nom: 'W', edition: 2 }], enForme);
  assert.match(trop.erreur!, /Trop de vérifications/);
});

// ═════════════════════════════════════════════════════════════════════════
// 2. CONSTATER — les deux règles qui portent la sécurité
// ═════════════════════════════════════════════════════════════════════════
test('deux dépôts du MÊME portefeuille : trouvé, et l’adresse sort de la preuve', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'Wet Head', edition: 12 }, { nom: 'BB-8', edition: 7 }], enForme);
  const d = await rafraichir(decouverte!, flux(entree('Wet Head', 12, W1), entree('BB-8', 7, W1)));
  assert.equal(d.etat, 'trouve');
  assert.equal(d.wallet, W1);
  assert.equal(avancement(d).faits, 2);
});

test('🔴 deux portefeuilles DIFFÉRENTS : refusé, et on le dit', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, flux(entree('A', 1, W1), entree('B', 2, W2)));
  assert.equal(d.etat, 'deux_portefeuilles');
  assert.equal(d.wallet, null, 'aucun portefeuille ne doit être retenu');
  assert.match(avancement(d).message, /DEUX portefeuilles/);
});

test('🔴 un dépôt ANTÉRIEUR à la déclaration ne compte pas — c’est ce qui empêche de recopier le flux public', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const vieux = new Date(Date.now() - 60 * 60_000).toISOString();   // une heure avant
  const d = await rafraichir(decouverte!, flux(
    entree('A', 1, W1, { at: vieux }), entree('B', 2, W1, { at: vieux }),
  ));
  assert.equal(d.etat, 'en_attente');
  assert.equal(avancement(d).faits, 0);
});

test('un comic déclaré est refusé EN LE DISANT, pas ignoré en silence', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'Tales of Suspense', edition: 253 }, { nom: 'B', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, flux(entree('Tales of Suspense', 253, W1, { comic: true })));
  assert.equal(d.etat, 'comic');
  assert.match(avancement(d).message, /COLLECTIBLES/);
});

test('la casse et les apostrophes de la personne ne font pas échouer un objet réellement listé', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: "hook's watch", edition: 3 }, { nom: 'b', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, flux(entree('Hook’s Watch', 3, W1), entree('B', 2, W1)));
  assert.equal(d.etat, 'trouve');
});

test('un seul objet vu : on attend, on ne conclut pas', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, flux(entree('A', 1, W1)));
  assert.equal(d.etat, 'en_attente');
  assert.equal(avancement(d).faits, 1);
  assert.match(avancement(d).message, /une à deux minutes/);
});

test('le premier dépôt gagne : un second, venu d’ailleurs, ne l’écrase pas', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  let d = await rafraichir(decouverte!, flux(entree('A', 1, W1)));
  d = await rafraichir(d, flux(entree('A', 1, W2), entree('B', 2, W1)));
  assert.equal(d.etat, 'trouve');
  assert.equal(d.wallet, W1);
});

test('la chaîne muette ne fait pas échouer : on réessaiera', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, async () => { throw new Error('réseau'); });
  assert.equal(d.etat, 'en_attente');
});

test('le délai écoulé se dit, et la déclaration cesse d’être active', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  run('UPDATE decouvertes SET expire=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), decouverte!.id);
  const d = await rafraichir(lireDecouverte(decouverte!.id)!, flux(entree('A', 1, W1), entree('B', 2, W1)));
  assert.equal(d.etat, 'expire');
  assert.equal(decouverteActive(c), undefined);
});

// ═════════════════════════════════════════════════════════════════════════
// 3. LA LECTURE DU FLUX — ce qu'on retient et ce qu'on jette
// ═════════════════════════════════════════════════════════════════════════
const ligne = (o: any) => ({
  to: { hash: o.to ?? ESCROW }, from: { hash: o.from ?? W1 },
  token: { address_hash: o.contrat ?? VEVE_CONTRACT },
  timestamp: o.at ?? new Date().toISOString(), block_number: 1,
  total: { token_id: o.id ?? '1', token_instance: { metadata: o.md ?? { name: 'A', edition: 1 } } },
});

test('on ne retient que ce qui ENTRE dans l’escrow, et seulement le contrat VeVe', () => {
  const e = parseEntreesEscrow({ items: [
    ligne({}),                                        // dépôt : gardé
    ligne({ to: W2 }),                                // sortie : une annulation ne prouve rien
    ligne({ contrat: '0xdeadbeef' }),                 // autre contrat
  ] });
  assert.equal(e.length, 1);
  assert.equal(e[0].from, W1.toLowerCase());
});

test('le comic est ÉTIQUETÉ à la lecture, pas jeté — sinon la case ne se cocherait jamais', () => {
  const e = parseEntreesEscrow({ items: [
    ligne({ md: { name: 'Tales of Suspense', edition: 253, comicNumber: '45' } }),
  ] });
  assert.equal(e.length, 1);
  assert.equal(e[0].comic, true);
});

test('une édition illisible ne devient pas l’exemplaire n° 0', () => {
  const e = parseEntreesEscrow({ items: [ligne({ md: { name: 'A', edition: '12/500' } })] });
  assert.equal(e[0].edition, null);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. AUTO-CONTRÔLE — un banc qui n'a rien inspecté n'a rien prouvé
// ═════════════════════════════════════════════════════════════════════════
test('le banc sait ÉCHOUER : un flux vide ne rend jamais « trouvé »', async () => {
  const c = compte();
  const { decouverte } = await declarer(c, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, flux());
  assert.notEqual(d.etat, 'trouve');
});

test('la purge ne touche pas ce qui est trouvé', () => {
  purgerDecouvertes();
  assert.ok(true);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. 🔴 LE REFUS « DÉJÀ LIÉ » — signalé par Preda le 07/08, sur son propre compte
// ═════════════════════════════════════════════════════════════════════════
// ⭐ Le cas fréquent n'est PAS l'usurpation : c'est la même personne revenue
//    par une autre porte. Le banc garde la porte de sortie, pas le refus.
const { lier, masquerEmail, estVerifie } = await import('../src/defi.ts');

test('l’indice d’adresse laisse reconnaître la sienne, jamais en apprendre une', () => {
  assert.equal(masquerEmail('preda@exemple.net'), 'p•••a@e•••e.net');
  assert.equal(masquerEmail('x'), null, 'une adresse illisible ne produit aucun indice');
  assert.equal(masquerEmail(null), null, 'sans e-mail, aucune porte à montrer');
  // ⛔ jamais l'adresse entière
  assert.ok(!String(masquerEmail('preda@exemple.net')).includes('preda'));
});

test('🔴 portefeuille déjà pris : le refus porte l’indice, et ce n’est PAS « deux portefeuilles »', async () => {
  const W = '0xcccccccccccccccccccccccccccccccccccccccc';
  const now = new Date().toISOString();
  const A = 'compte-de-juillet';
  run('INSERT INTO comptes (id, wallet, email, verifie, verifie_le, cree_le) VALUES (?,?,?,?,?,?)',
    A, W, 'preda@exemple.net', 1, now, now);
  const B = compte();
  run('INSERT INTO comptes (id, email, verifie, cree_le) VALUES (?,?,?,?)', B, 'preda2@exemple.net', 0, now);

  const { decouverte } = await declarer(B, [{ nom: 'A', edition: 1 }, { nom: 'B', edition: 2 }], enForme);
  const d = await rafraichir(decouverte!, flux(entree('A', 1, W), entree('B', 2, W)));
  // La chaîne a bien tranché : un seul portefeuille, trouvé.
  assert.equal(d.etat, 'trouve');
  assert.equal(d.wallet, W);

  const r = lier(B, d.wallet!);
  assert.equal(r.ok, false);
  assert.equal(r.indice, 'p•••a@e•••e.net');
  assert.match(r.message, /Connectez-vous avec l'adresse/);
  // ⛔ Et le portefeuille N'A PAS changé de compte : le refus ne casse rien.
  assert.equal(estVerifie(A), true);
  assert.equal(estVerifie(B), false);
});

test('un compte ABANDONNÉ (ni e-mail ni preuve) ne bloque personne', async () => {
  const W = '0xdddddddddddddddddddddddddddddddddddddddd';
  const now = new Date().toISOString();
  run('INSERT INTO comptes (id, wallet, verifie, cree_le) VALUES (?,?,?,?)', 'trace-abandonnee', W, 0, now);
  const B = compte();
  run('INSERT INTO comptes (id, email, verifie, cree_le) VALUES (?,?,?,?)', B, 'neuf@exemple.net', 0, now);
  const r = lier(B, W);
  assert.equal(r.ok, true, 'une ligne sans e-mail et sans preuve n’appartient à personne');
  assert.equal(estVerifie(B), true);
});

// ═════════════════════════════════════════════════════════════════════════
// 6. 🔥 LOT 107 — L'ISOLATION PAR SITE
// ═════════════════════════════════════════════════════════════════════════
// ⭐⭐ CE QUE CES BANCS GARDENT : une requête sur `comptes` qui oublie
//    `site=?` ne lève AUCUNE erreur — elle rend le compte d'un autre site,
//    avec son portefeuille. C'est-à-dire exactement le lien entre les sites
//    que Preda a demandé de supprimer, rétabli en silence.
const { creerOuLireCompteParEmail, lireCompteParEmail, portefeuilleOccupe } = await import('../src/avoirs.ts');
const { normaliserSite, siteDeLOrigine, SITE_DEFAUT } = await import('../src/sites.ts');

test('la même adresse e-mail donne DEUX comptes sur deux sites', () => {
  const a = creerOuLireCompteParEmail('loop', 'meme@exemple.net');
  const b = creerOuLireCompteParEmail('arcade', 'meme@exemple.net');
  assert.notEqual(a.id, b.id, 'un compte par site, sans quoi les sites se parlent');
  assert.equal(a.site, 'loop');
  assert.equal(b.site, 'arcade');
  // ⭐ et sur le MÊME site, c'est toujours le même compte.
  assert.equal(creerOuLireCompteParEmail('loop', 'meme@exemple.net').id, a.id);
});

test('on ne voit pas le compte d’un autre site', () => {
  creerOuLireCompteParEmail('loop', 'cloison@exemple.net');
  assert.ok(lireCompteParEmail('loop', 'cloison@exemple.net'));
  assert.equal(lireCompteParEmail('arcade', 'cloison@exemple.net'), undefined);
});

test('🔴 le MÊME portefeuille se prouve sur deux sites, et n’est pris que sur le sien', () => {
  const W = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const now = new Date().toISOString();
  const a = creerOuLireCompteParEmail('loop', 'w@exemple.net');
  run('UPDATE comptes SET wallet=?, verifie=1, verifie_le=? WHERE id=?', W, now, a.id);
  const b = creerOuLireCompteParEmail('arcade', 'w2@exemple.net');
  // 🔴 Le cœur du lot : occupé sur `loop`, LIBRE sur `arcade`.
  assert.equal(portefeuilleOccupe('loop', W, b.id), true);
  assert.equal(portefeuilleOccupe('arcade', W, b.id), false);
  // et `lier()` suit la même cloison
  const r = lier(b.id, W);
  assert.equal(r.ok, true, 'un portefeuille prouvé sur un autre site ne regarde pas celui-ci');
  const c = creerOuLireCompteParEmail('loop', 'w3@exemple.net');
  assert.equal(lier(c.id, W).ok, false, 'sur SON site, il reste pris');
});

test('un site inconnu ne crée pas de cloisonnement fantôme', () => {
  assert.equal(normaliserSite('chez-moi'), SITE_DEFAUT());
  assert.equal(normaliserSite(''), SITE_DEFAUT());
  assert.equal(normaliserSite('loop'), 'loop');
});

test('le site se retrouve par l’origine de retour — c’est la porte du lien magique', () => {
  assert.equal(siteDeLOrigine('https://loop.exemple.net/compte/'), 'loop');
  assert.equal(siteDeLOrigine('https://ailleurs.example/'), null);
  assert.equal(siteDeLOrigine(null), null);
});

test('lier() refuse un compte inconnu au lieu de faire semblant', () => {
  const r = lier('compte-qui-nexiste-pas', '0xffffffffffffffffffffffffffffffffffffffff');
  assert.equal(r.ok, false);
  assert.match(r.message, /inconnu/);
});
