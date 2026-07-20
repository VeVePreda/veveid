import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { q1, fermer as fermerBase } from './src/db.ts';
import { COOKIE, creerJeton, lireJeton, lireCookie } from './src/session.ts';
import { autorise, adresse, purgerSeaux, REGLES } from './src/limite.ts';
import { isWallet } from './src/collectchain.ts';
import { preparer, creerDefi, lireDefi, defiActif, rafraichir, avancement, lier, estVerifie, purgerDefis, NB_CIBLES } from './src/defi.ts';
import {
  creerOuLireCompte, lireCompte, synchroniser, avoirsDe, dernierSync, estAbonne,
  noterAcces, demanderSuppression, annulerSuppression, purgerComptes, accorderAbonnement,
} from './src/avoirs.ts';
import { signer, memeSecret, fabriquerCles } from './src/jetons.ts';
import { jeux, jeuConnu, retourAutorise, origineDe } from './src/jeux.ts';
import { accueil, pageChoisir, pageDefi, pageCompte, page } from './src/vues.ts';

const PORT = Number(process.env.PORT ?? 3000);
const clePrivee = () => process.env.ID_PRIVEE ?? '';
const clePubliqueTexte = () => process.env.ID_PUBLIQUE ?? '';
const cleService = () => process.env.ID_SERVICE ?? '';

const html = (res: ServerResponse, corps: string, code = 200, entetes: Record<string, string> = {}) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...entetes });
  res.end(corps);
};
const json = (res: ServerResponse, o: unknown, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(o));
};
const vers = (res: ServerResponse, url: string, entetes: Record<string, string> = {}) => {
  res.writeHead(302, { location: url, ...entetes }); res.end();
};
const corpsDe = async (req: any): Promise<URLSearchParams> => {
  const c: Buffer[] = []; let taille = 0;
  for await (const x of req) { taille += (x as Buffer).length; if (taille > 64_000) break; c.push(x as Buffer); }
  return new URLSearchParams(Buffer.concat(c).toString());
};

/**
 * ⚠️ Le jeu et l'adresse de retour voyagent dans un COOKIE, pas dans la
 *    session ni dans l'URL de chaque page. Le joueur part dans
 *    l'application VeVe et revient trois minutes plus tard : l'URL est
 *    perdue, la session peut avoir été recréée, mais le cookie tient.
 */
const COOKIE_DEST = 'veveid_dest';
const lireDest = (req: any): { jeu: string; retour: string } | null => {
  try {
    const brut = lireCookie(req.headers.cookie, COOKIE_DEST);
    if (!brut) return null;
    const d = JSON.parse(Buffer.from(brut, 'base64url').toString());
    return jeuConnu(d.jeu) && retourAutorise(d.jeu, d.retour) ? d : null;
  } catch { return null; }
};
const poserDest = (jeu: string, retour: string) =>
  `${COOKIE_DEST}=${Buffer.from(JSON.stringify({ jeu, retour })).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;

export const serveur = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
  catch { return html(res, accueil(undefined, 'Adresse invalide.'), 400); }
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method ?? 'GET';
  const compteId = lireJeton(lireCookie(req.headers.cookie, COOKIE));
  const ip = adresse(req.headers as any, req.socket.remoteAddress);
  const trop = (r: typeof REGLES.api) => !autorise(`${ip}|${p}`, r);

  try {
    if (m === 'GET' && p === '/sante') return json(res, { ok: true, at: new Date().toISOString() });

    /**
     * ⭐⭐ L'API DE SERVICE — ce que les JEUX appellent, jamais un navigateur.
     *
     * 🔴 Authentifiée par un secret partagé (`ID_SERVICE`), comparé à durée
     *    constante. Ce secret ne permet QUE DE LIRE : il ne signe rien, donc
     *    un jeu compromis ne peut usurper personne.
     *
     * ⚠️ Elle est traitée EN TÊTE, avant toute logique de session : un jeu
     *    n'a pas de cookie, et il ne doit surtout pas être redirigé vers
     *    une page HTML quand il attend du JSON.
     */
    if (p.startsWith('/api/')) {
      const fourni = String(req.headers['x-service'] ?? '');
      if (!cleService() || !memeSecret(fourni, cleService())) return json(res, { erreur: 'refusé' }, 401);
      const c = lireCompte(url.searchParams.get('compte') ?? '');
      if (!c || !c.verifie) return json(res, { erreur: 'compte inconnu' }, 404);
      if (p === '/api/avoirs') return json(res, {
        compte: c.id, wallet: c.wallet,
        abonne: estAbonne(c) ? c.abonne_jusqu_a : null,
        supprime: !!c.supprime_le,
        avoirs: avoirsDe(c.id),
        sync: dernierSync(c.id) ?? null,
      });
      if (p === '/api/compte') return json(res, {
        compte: c.id, wallet: c.wallet,
        abonne: estAbonne(c) ? c.abonne_jusqu_a : null, supprime: !!c.supprime_le,
      });
      return json(res, { erreur: 'route inconnue' }, 404);
    }

    /**
     * ⭐ La clé PUBLIQUE est servie en clair, exprès : n'importe quel jeu
     *    doit pouvoir la récupérer pour vérifier les jetons. Elle ne
     *    permet que de VÉRIFIER, jamais de signer.
     */
    if (m === 'GET' && p === '/cle-publique') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return res.end(clePubliqueTexte());
    }

    // ── L'entrée d'un jeu ───────────────────────────────────────────────
    if (m === 'GET' && p === '/connexion') {
      const jeu = url.searchParams.get('jeu') ?? '';
      const retour = url.searchParams.get('retour') ?? origineDe(jeu) ?? '';
      /**
       * 🔴 LE CONTRÔLE QUI EMPÊCHE LA REDIRECTION OUVERTE. Sans lui,
       *    n'importe qui enverrait un joueur ici avec sa propre adresse de
       *    retour et récupérerait un jeton d'identité valide.
       */
      if (!jeuConnu(jeu)) return html(res, accueil(undefined, 'Jeu inconnu.'), 400);
      if (!retourAutorise(jeu, retour))
        return html(res, accueil(undefined, 'Adresse de retour refusée.'), 400);

      const entetes = { 'set-cookie': poserDest(jeu, retour) };
      if (compteId && estVerifie(compteId)) return vers(res, '/apres', entetes);
      return html(res, accueil(jeu), 200, entetes);
    }

    if (m === 'POST' && p === '/entrer') {
      if (trop(REGLES.verifier)) return html(res, accueil(undefined, 'Trop de tentatives. Patientez.'), 429);
      const b = await corpsDe(req);
      const wallet = String(b.get('wallet') ?? '').trim();
      if (!isWallet(wallet))
        return html(res, accueil(undefined, 'Adresse invalide : elle commence par 0x et fait 42 caractères.'), 400);
      const c = creerOuLireCompte(wallet);
      return vers(res, c.verifie ? '/compte' : '/choisir', {
        'set-cookie': `${COOKIE}=${creerJeton(c.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      });
    }

    const compte = compteId ? lireCompte(compteId) : undefined;
    if (!compte) return m === 'GET' && p === '/' ? html(res, accueil()) : vers(res, '/');

    if (m === 'GET' && p === '/deconnexion')
      return vers(res, '/', { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });

    // ── La vérification ─────────────────────────────────────────────────
    if (m === 'GET' && p === '/choisir') {
      if (compte.verifie) return vers(res, '/compte');
      if (defiActif(compte.wallet)) return vers(res, '/verification');
      if (trop(REGLES.verifier)) return html(res, pageChoisir({}, 'Trop de lectures. Patientez une minute.'), 429);
      const e = await preparer(compte.wallet);
      return html(res, pageChoisir(e, e.erreur));
    }
    if (m === 'POST' && p === '/choisir') {
      if (compte.verifie) return vers(res, '/compte');
      const b = await corpsDe(req);
      const { defi, erreur } = await creerDefi(compte.wallet, compte.id, b.getAll('t').slice(0, NB_CIBLES + 4));
      if (erreur || !defi) return html(res, pageChoisir(await preparer(compte.wallet), erreur), 400);
      return vers(res, '/verification');
    }
    if (m === 'GET' && p === '/verification') {
      if (compte.verifie) return vers(res, '/compte');
      const d = defiActif(compte.wallet);
      if (!d) return vers(res, '/choisir');
      return html(res, pageDefi(avancement(d), d.id));
    }
    if (m === 'GET' && p === '/defi.json') {
      if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
      const d = lireDefi(url.searchParams.get('id') ?? '');
      if (!d || d.wallet !== compte.wallet) return json(res, { erreur: 'défi inconnu' }, 404);
      const frais = await rafraichir(d);
      if (frais.etat === 'verifie' && !estVerifie(compte.id)) {
        lier(compte.id, frais.wallet);
        try { await synchroniser(compte.id, frais.wallet); } catch { /* on réessaiera */ }
      }
      return json(res, avancement(frais));
    }

    /**
     * ⭐ LE RETOUR AU JEU. C'est le seul endroit où un jeton est émis.
     *
     * ⚠️ Il part dans l'URL, donc il est court (deux minutes) et à usage
     *    unique de fait : le jeu s'en sert pour poser SA session, et le
     *    jeton n'ouvre plus rien ensuite.
     */
    if (m === 'GET' && p === '/apres') {
      if (!compte.verifie) return vers(res, '/choisir');
      const dest = lireDest(req);
      if (!dest) return vers(res, '/compte');
      if (!clePrivee()) return html(res, page('Identité', '<p>Service mal configuré : ID_PRIVEE absente.</p>'), 500);
      noterAcces(compte.id, dest.jeu);
      const jeton = signer({
        compte: compte.id, wallet: compte.wallet, jeu: dest.jeu,
        abonne: estAbonne(compte) ? compte.abonne_jusqu_a : null,
      }, clePrivee());
      const u = new URL(dest.retour);
      u.searchParams.set('jeton', jeton);
      return vers(res, u.toString(), { 'set-cookie': `${COOKIE_DEST}=; Path=/; Max-Age=0` });
    }

    // ── Le compte ───────────────────────────────────────────────────────
    if (m === 'GET' && p === '/compte' || (m === 'GET' && p === '/')) {
      if (!compte.verifie) return vers(res, '/choisir');
      const dest = lireDest(req);
      return html(res, pageCompte(
        compte, avoirsDe(compte.id), estAbonne(compte), dernierSync(compte.id),
        dest?.jeu ?? null, url.searchParams.get('msg') ?? undefined,
      ));
    }
    if (m === 'POST' && p === '/synchroniser') {
      if (trop(REGLES.verifier)) return vers(res, '/compte?msg=' + encodeURIComponent('Un instant — lecture déjà demandée.'));
      const b = await synchroniser(compte.id, compte.wallet);
      return vers(res, '/compte?msg=' + encodeURIComponent(b.erreur
        ? 'La chaîne ne répond pas. Rien n’a été touché.'
        : `${b.vus} collectibles lus, ${b.nouveaux} nouveaux${b.partis ? `, ${b.partis} partis` : ''}${b.complet ? '' : ' — vue partielle, rien retiré'}.`));
    }
    if (m === 'POST' && p === '/supprimer')
      return vers(res, '/compte?msg=' + encodeURIComponent(demanderSuppression(compte.id).message));
    if (m === 'POST' && p === '/annuler-suppression')
      return vers(res, '/compte?msg=' + encodeURIComponent(annulerSuppression(compte.id).message));

    return vers(res, '/compte');
  } catch (e) {
    console.error('[identité]', e);
    return html(res, accueil(undefined, 'Quelque chose a cassé de notre côté.'), 500);
  }
});

export function demarrer(port = PORT): void {
  serveur.listen(port, () => {
    console.log(`[identité] à l'écoute sur ${port}`);
    const j = [...jeux().keys()];
    console.log(`[identité] jeux déclarés : ${j.length ? j.join(', ') : 'AUCUN — variable JEUX vide'}`);
    if (!clePrivee() || !clePubliqueTexte())
      console.error('🔴 [identité] ID_PRIVEE ou ID_PUBLIQUE absente : aucun jeton ne sera émis.');
    if (!cleService()) console.warn('[identité] ID_SERVICE absente : l’API est fermée aux jeux.');
    const menage = setInterval(() => {
      purgerSeaux(); purgerDefis();
      const n = purgerComptes();
      if (n) console.log(`[identité] ${n} compte(s) effacé(s) après le délai de grâce.`);
    }, 3600_000);
    menage.unref?.();
  });
  const stop = () => { purgerSeaux(); serveur.close(); fermerBase(); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

/** `node server.ts --cles` fabrique la paire, une fois, à la main. */
if (process.argv.includes('--cles')) {
  const c = fabriquerCles();
  console.log(`ID_PUBLIQUE=${c.publique}\nID_PRIVEE=${c.privee}`);
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demarrer();
}
