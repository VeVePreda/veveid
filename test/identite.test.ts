import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dossier = mkdtempSync(join(tmpdir(), 'veveid-'));
process.env.DB_PATH = join(dossier, 'id.db');
process.env.JEUX = 'loop=https://loop.exemple.net,arcade=https://arcade.exemple.net';

const { q1, run, fermer } = await import('../src/db.ts');
const { creerOuLireCompte, synchroniser, avoirsDe, demanderSuppression,
  annulerSuppression, accorderAbonnement, estAbonne, lireCompte, effacerDefinitivement,
  DELAI_GRACE_JOURS } = await import('../src/avoirs.ts');
const {
  preparer, creerDefi, lireDefi, defiActif, rafraichir, lier, estVerifie, avancement,
  purgerDefis, tentativesDuJour, NB_CIBLES, MAX_TENTATIVES_JOUR, PRIX_MIN, PRIX_MAX,
} = await import('../src/defi.ts');
const { parseHoldings, parseEscrowDeposits, parseEnVente, estUnComic, isWallet, ESCROW, VEVE_CONTRACT } =
  await import('../src/collectchain.ts');
const { mintKeyDe } = await import('../src/avoirs.ts');
const { fabriquerCles, signer, verifier } = await import('../src/jetons.ts');
const { jeux, oublierJeux, jeuConnu, retourAutorise } = await import('../src/jeux.ts');

after(() => { fermer(); rmSync(dossier, { recursive: true, force: true }); });

const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const avoirs = (n: number) => Array.from({ length: n }, (_, i) => ({
  tokenId: `t${i}`, name: `Objet ${i}`, edition: i + 1, totalEditions: 1000,
  rarity: 'COMMON', series: null, image: null,
}));
const lireAvoirs = (n: number) => async () => avoirs(n);
const rienEnVente = async () => new Map();
const enPanne = async () => false;
const enForme = async () => true;
const depot = (t: string) => ({ tokenId: t, name: t, edition: 1, at: new Date().toISOString(), block: 1 });

// ═════════════════════════════════════════════════════════════════════════
// Lecture de la chaîne
// ═════════════════════════════════════════════════════════════════════════

test('une adresse de portefeuille se reconnaît, et rien d’autre', () => {
  assert.equal(isWallet(W), true);
  assert.equal(isWallet('0x123'), false);
  assert.equal(isWallet('pas une adresse'), false);
});

test('🔴 un comic n’est pas un héros — les DEUX marqueurs', () => {
  // Preda détient 1 409 comics pour 314 collectibles : sans ce filtre, ils
  // entraient tous dans le jeu et la page pesait 4,4 Mo.
  assert.equal(estUnComic({ comicNumber: '10' }), true);
  assert.equal(estUnComic({}, 'https://x/comic_cover/abc.jpg'), true);
  assert.equal(estUnComic({ comicNumber: '' }, 'https://x/collectible_type_image/a.jpg'), false);
});

test('les avoirs se lisent, et une édition illisible ne casse pas la lecture', () => {
  const payload = { items: [
    { id: '1', token: { address_hash: VEVE_CONTRACT }, metadata: { name: 'Bon', edition: 12, image: 'a.png' } },
    // 🔴 `Number('12/500')` vaut NaN : il traversait le filtre et faisait
    // échouer l'insertion en base, condamnant le portefeuille entier.
    { id: '2', token: { address_hash: VEVE_CONTRACT }, metadata: { name: 'Cassé', edition: '12/500' } },
    { id: '3', token: { address_hash: VEVE_CONTRACT }, metadata: { name: 'Vide', edition: '' } },
    { id: '4', token: { address_hash: '0xautre' }, metadata: { name: 'Étranger', edition: 3 } },
    { id: '5', token: { address_hash: VEVE_CONTRACT }, metadata: { name: 'Comic', edition: 4, comicNumber: '7' } },
  ] };
  assert.deepEqual(parseHoldings(payload).map((x) => x.name), ['Bon']);
});

test('un dépôt en escrow se distingue d’un transfert ordinaire', () => {
  const payload = { items: [
    { to: { hash: ESCROW }, timestamp: '2026-07-20T10:00:00Z', block_number: 1,
      total: { token_id: 't1', token_instance: { metadata: { name: 'A', edition: 5 } } } },
    { to: { hash: '0xacheteur' }, timestamp: '2026-07-20T10:00:00Z', block_number: 2,
      total: { token_id: 't2', token_instance: { metadata: { name: 'B', edition: 6 } } } },
  ] };
  assert.deepEqual(parseEscrowDeposits(payload).map((d) => d.tokenId), ['t1']);
});

test('⚠️ un objet EN VENTE n’est pas un objet VENDU', () => {
  const payload = { items: [
    { token: { address_hash: VEVE_CONTRACT }, from: { hash: W }, to: { hash: ESCROW },
      timestamp: '2026-07-20T10:00:00Z', total: { token_id: 't1', token_instance: { metadata: { name: 'A', edition: 1 } } } },
    { token: { address_hash: VEVE_CONTRACT }, from: { hash: W }, to: { hash: ESCROW },
      timestamp: '2026-07-20T09:00:00Z', total: { token_id: 't2', token_instance: { metadata: { name: 'B', edition: 2 } } } },
    { token: { address_hash: VEVE_CONTRACT }, from: { hash: ESCROW }, to: { hash: W },
      timestamp: '2026-07-20T09:30:00Z', total: { token_id: 't2', token_instance: { metadata: { name: 'B', edition: 2 } } } },
  ] };
  const v = parseEnVente(payload, W);
  assert.equal(v.has('t1'), true, 'déposé et jamais revenu : il est en vente');
  assert.equal(v.has('t2'), false, 'revenu en portefeuille : la vente a été annulée');
});

// ═════════════════════════════════════════════════════════════════════════
// Préparer le choix
// ═════════════════════════════════════════════════════════════════════════

test('🔴 CollectScan en panne se DIT — ce n’est pas « aucun collectible »', async () => {
  /**
   * Sans ce contrôle, une panne d'un service tiers se présente au joueur
   * comme SA faute. Il refait le geste, il échoue encore, il s'en va.
   */
  const e = await preparer(W, lireAvoirs(5), rienEnVente, enPanne);
  assert.equal(e.panne, true);
  assert.match(e.erreur!, /CollectScan/);
  assert.match(e.erreur!, /Ce n'est pas vous/);
  assert.equal(e.liste, undefined, 'on ne propose rien quand on ne sait rien');
});

test('une coupure en cours de lecture se dit aussi', async () => {
  const e = await preparer(W, async () => { throw new Error('réseau'); }, rienEnVente, enForme);
  assert.equal(e.panne, true);
  assert.match(e.erreur!, /échoué/);
});

test('⭐ les objets DÉJÀ EN VENTE sont écartés du choix', async () => {
  /**
   * Un objet déjà déposé en escrow ne produira aucun NOUVEAU dépôt : le
   * joueur attendrait devant une case qui ne se coche jamais.
   */
  const dejaListes = async () => new Map([['t0', {}], ['t1', {}]]) as any;
  const e = await preparer(W, lireAvoirs(5), dejaListes, enForme);
  assert.deepEqual(e.liste!.map((x) => x.tokenId), ['t2', 't3', 't4']);
  assert.deepEqual(e.ecartes!.map((x) => x.tokenId), ['t0', 't1']);
});

test('trop d’objets déjà listés : on l’explique au lieu de proposer le vide', async () => {
  const presqueTout = async () => new Map([['t0', {}], ['t1', {}]]) as any;
  const e = await preparer(W, lireAvoirs(3), presqueTout, enForme);
  assert.match(e.erreur!, /déjà en vente/);
  assert.equal(e.liste!.length, 1);
});

test('un portefeuille vide ne peut pas jouer', async () => {
  const e = await preparer(W, lireAvoirs(0), rienEnVente, enForme);
  assert.match(e.erreur!, /Aucun collectible/);
});

// ═════════════════════════════════════════════════════════════════════════
// Le choix du joueur
// ═════════════════════════════════════════════════════════════════════════

test('le joueur choisit ses objets, et le défi les retient', async () => {
  const c = creerOuLireCompte('veveprice', W);
  const { defi, erreur } = await creerDefi(W, c.id, ['t1', 't3'], lireAvoirs(6), rienEnVente, enForme);
  assert.equal(erreur, undefined);
  assert.deepEqual(defi!.cibles.map((x) => x.tokenId), ['t1', 't3']);
  assert.ok(PRIX_MIN < PRIX_MAX && PRIX_MIN >= 15000, 'les bornes de prix protègent le joueur');
});

test('🔴 LE CHOIX EST SCELLÉ — on ne le remanie pas tant qu’il court', async () => {
  /**
   * C'est ce qui remplace « le tirage est subi » depuis que le joueur
   * choisit. Sans cela, un imposteur changerait d'objets jusqu'à tomber
   * sur deux pièces que le vrai détenteur liste par hasard.
   */
  const c = creerOuLireCompte('veveprice', W);
  const r = await creerDefi(W, c.id, ['t0', 't2'], lireAvoirs(6), rienEnVente, enForme);
  assert.deepEqual(r.defi!.cibles.map((x) => x.tokenId), ['t1', 't3'], 'le défi en cours a été remplacé');
});

test('🔴 on ne fait PAS confiance au formulaire', async () => {
  const c = creerOuLireCompte('veveprice','0xcccccccccccccccccccccccccccccccccccccccc');
  const w = '0xcccccccccccccccccccccccccccccccccccccccc';
  // Un objet qui n'est pas dans les avoirs.
  let r = await creerDefi(w, c.id, ['t1', 'inexistant'], lireAvoirs(6), rienEnVente, enForme);
  assert.match(r.erreur!, /n'est plus disponible/);
  // Un objet déjà en vente, donc écarté.
  const listes = async () => new Map([['t1', {}]]) as any;
  r = await creerDefi(w, c.id, ['t1', 't2'], lireAvoirs(6), listes, enForme);
  assert.match(r.erreur!, /n'est plus disponible/);
  // Le mauvais nombre d'objets.
  r = await creerDefi(w, c.id, ['t1'], lireAvoirs(6), rienEnVente, enForme);
  assert.match(r.erreur!, new RegExp(`exactement ${NB_CIBLES}`));
  r = await creerDefi(w, c.id, ['t1', 't2', 't3'], lireAvoirs(6), rienEnVente, enForme);
  assert.match(r.erreur!, new RegExp(`exactement ${NB_CIBLES}`));
  // Deux fois le même objet ne fait pas deux objets.
  r = await creerDefi(w, c.id, ['t1', 't1'], lireAvoirs(6), rienEnVente, enForme);
  assert.match(r.erreur!, new RegExp(`exactement ${NB_CIBLES}`));
});

test('⭐ le nombre de tentatives est borné par jour', async () => {
  const w = '0xffffffffffffffffffffffffffffffffffffffff';
  const c = creerOuLireCompte('veveprice', w, 'UTC');
  for (let i = 0; i < MAX_TENTATIVES_JOUR; i++) {
    const r = await creerDefi(w, c.id, ['t0', 't1'], lireAvoirs(6), rienEnVente, enForme);
    assert.ok(r.defi, `tentative ${i + 1} refusée à tort`);
    // On périme le défi pour pouvoir en retenter un.
    run('UPDATE defis SET expire=?, etat=? WHERE id=?',
      new Date(Date.now() - 1000).toISOString(), 'expire', r.defi!.id);
  }
  assert.equal(tentativesDuJour(w), MAX_TENTATIVES_JOUR);
  const trop = await creerDefi(w, c.id, ['t0', 't1'], lireAvoirs(6), rienEnVente, enForme);
  assert.match(trop.erreur!, /Trop de vérifications/);
});

// ═════════════════════════════════════════════════════════════════════════
// Constater le geste
// ═════════════════════════════════════════════════════════════════════════

test('⭐ le geste est constaté, et la liaison est scellée', async () => {
  const c = creerOuLireCompte('veveprice', W);
  const d = defiActif(W)!;
  const [c1, c2] = d.cibles;

  let frais = await rafraichir(d, async () => [depot(c1.tokenId)]);
  assert.equal(frais.etat, 'en_attente');
  assert.equal(avancement(frais).faits, 1);

  frais = await rafraichir(lireDefi(d.id)!, async () => [depot(c1.tokenId), depot(c2.tokenId)]);
  assert.equal(frais.etat, 'verifie');

  assert.equal(estVerifie(c.id), false, 'la liaison ne doit pas se faire toute seule');
  assert.equal(lier(c.id, W).ok, true);
  assert.equal(estVerifie(c.id), true);
});

test('🔴 un dépôt ANTÉRIEUR au défi ne vaut rien', async () => {
  /**
   * Indispensable depuis que le joueur choisit : sans cela, il suffirait
   * de désigner deux objets qu'on a listés la semaine dernière.
   */
  const w = '0x1010101010101010101010101010101010101010';
  const c = creerOuLireCompte('veveprice', w, 'UTC');
  const { defi } = await creerDefi(w, c.id, ['t0', 't1'], lireAvoirs(4), rienEnVente, enForme);
  const vieux = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const frais = await rafraichir(defi!, async () => [
    { tokenId: 't0', name: 'x', edition: 1, at: vieux, block: 1 },
    { tokenId: 't1', name: 'y', edition: 2, at: vieux, block: 2 },
  ]);
  assert.equal(frais.etat, 'en_attente', 'des dépôts anciens ont validé le défi');
});

test('un défi expiré est expiré, et il le reste', async () => {
  const w = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const c = creerOuLireCompte('veveprice', w, 'UTC');
  const { defi } = await creerDefi(w, c.id, ['t0', 't1'], lireAvoirs(5), rienEnVente, enForme);
  run('UPDATE defis SET expire=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), defi!.id);
  const frais = await rafraichir(lireDefi(defi!.id)!, async () => [depot('t0'), depot('t1')]);
  assert.equal(frais.etat, 'expire', 'un défi expiré ne doit pas se laisser rattraper');
  assert.equal(defiActif(w), undefined);
});

test('🔴 un portefeuille = un compte', async () => {
  const autre = creerOuLireCompte('veveprice', W2);
  const r = lier(autre.id, W);
  assert.equal(r.ok, false);
  assert.match(r.message, /déjà lié/);
  const d = await creerDefi(W, autre.id, ['t0', 't1'], lireAvoirs(6), rienEnVente, enForme);
  assert.match(d.erreur!, /déjà lié/);
});

test('la purge épargne les défis vérifiés', () => {
  run('UPDATE defis SET cree=? WHERE etat=?', new Date(Date.now() - 4 * 3600_000).toISOString(), 'expire');
  purgerDefis();
  assert.ok(q1("SELECT 1 FROM defis WHERE etat='verifie'"), 'la preuve d’une liaison ne doit pas s’effacer');
});



// ═════════════════════════════════════════════════════════════════════════
// Le jeton, les jeux autorisés, et le compte
// ═════════════════════════════════════════════════════════════════════════

test('⭐ un jeton signé se vérifie, et seulement pour son destinataire', () => {
  const c = fabriquerCles();
  const j = signer({ compte: 'abc', wallet: '0xabc', jeu: 'loop', abonne: null }, c.privee);
  assert.equal(verifier(j, c.publique, 'loop').ok, true);
  assert.equal(verifier(j, c.publique, 'arcade').ok, false);
  const autre = fabriquerCles();
  assert.equal(verifier(j, autre.publique, 'loop').ok, false);
});

test('🔴 LA LISTE DES JEUX EMPÊCHE LA REDIRECTION OUVERTE', () => {
  /**
   * Sans elle, n'importe qui enverrait un joueur ici avec sa propre
   * adresse de retour et récupérerait un jeton d'identité valide. Toute
   * la vérification de propriété ne vaudrait plus rien.
   */
  oublierJeux();
  assert.equal(jeuConnu('loop'), true);
  assert.equal(jeuConnu('pirate'), false);
  assert.equal(retourAutorise('loop', 'https://loop.exemple.net/retour'), true);
  assert.equal(retourAutorise('loop', 'https://chez-moi.example/vol'), false);
  // ⚠️ Le piège du préfixe : ce domaine appartient à l'attaquant et
  //    commence pourtant par le bon texte.
  assert.equal(retourAutorise('loop', 'https://loop.exemple.net.chez-moi.example/'), false);
  assert.equal(retourAutorise('loop', 'http://loop.exemple.net/'), false, 'le protocole compte');
  assert.equal(retourAutorise('arcade', 'https://loop.exemple.net/'), false, 'chacun chez soi');
});

test('un compte se crée en minuscules et une seule fois', () => {
  const a = creerOuLireCompte('veveprice','0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const b = creerOuLireCompte('veveprice','0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(a.id, b.id);
  assert.equal(a.wallet, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('⭐ les avoirs se synchronisent, et une vue partielle ne retire RIEN', async () => {
  const c = creerOuLireCompte('veveprice','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1');
  const liste = (n: number) => Array.from({ length: n }, (_, i) => ({
    tokenId: `t${i}`, name: `Objet ${i}`, edition: i + 1,
    totalEditions: null, rarity: 'COMMON', series: null, image: null,
  }));
  await synchroniser(c.id, c.wallet, async () => ({ liste: liste(3), complet: true }));
  assert.equal(avoirsDe(c.id).length, 3);
  await synchroniser(c.id, c.wallet, async () => ({ liste: liste(1), complet: false }));
  assert.equal(avoirsDe(c.id).length, 3, 'une vue partielle a retiré des avoirs');
  await synchroniser(c.id, c.wallet, async () => ({ liste: liste(1), complet: true }));
  assert.equal(avoirsDe(c.id).length, 1);
});

test('une chaîne injoignable ne retire rien non plus', async () => {
  const c = creerOuLireCompte('veveprice','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2');
  await synchroniser(c.id, c.wallet, async () => ({
    liste: [{ tokenId: 't', name: 'A', edition: 1, totalEditions: null, rarity: null, series: null, image: null }],
    complet: true,
  }));
  const b = await synchroniser(c.id, c.wallet, async () => { throw new Error('réseau'); });
  assert.equal(b.erreur, 'chaîne injoignable');
  assert.equal(avoirsDe(c.id).length, 1);
});

test('l’abonnement se cumule au lieu de repartir de zéro', () => {
  const c = creerOuLireCompte('veveprice','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb3');
  accorderAbonnement(c.id, 30);
  const apres1 = lireCompte(c.id)!.abonne_jusqu_a!;
  accorderAbonnement(c.id, 30);
  assert.ok(lireCompte(c.id)!.abonne_jusqu_a! > apres1, 'le second mois a écrasé le premier');
  assert.equal(estAbonne(lireCompte(c.id)!), true);
});

test('⭐ la suppression laisse un DÉLAI DE GRÂCE', () => {
  /**
   * Une suppression immédiate est irréversible : un clic de trop, et des
   * mois de codex disparaissent. Le délai ne coûte rien à personne — le
   * compte est déjà inaccessible pendant ce temps.
   */
  const c = creerOuLireCompte('veveprice','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb4');
  assert.equal(demanderSuppression(c.id).ok, true);
  assert.ok(lireCompte(c.id)!.supprime_le, 'la demande doit être datée');
  assert.equal(demanderSuppression(c.id).ok, false, 'deux fois ne veut rien dire');
  assert.equal(annulerSuppression(c.id).ok, true);
  assert.equal(lireCompte(c.id)!.supprime_le, null);
  assert.ok(DELAI_GRACE_JOURS >= 3, 'un délai trop court ne laisse pas revenir');
});

test('effacer pour de bon ne laisse rien derrière', async () => {
  const c = creerOuLireCompte('veveprice','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5');
  await synchroniser(c.id, c.wallet, async () => ({
    liste: [{ tokenId: 't', name: 'A', edition: 1, totalEditions: null, rarity: null, series: null, image: null }],
    complet: true,
  }));
  effacerDefinitivement(c.id);
  assert.equal(lireCompte(c.id), undefined);
  assert.equal(avoirsDe(c.id).length, 0);
});

test('la clé du mint reste nom:edition', () => {
  assert.equal(mintKeyDe({ name: 'Spider-Man 2099', edition: 42 }), 'Spider-Man 2099:42');
});
