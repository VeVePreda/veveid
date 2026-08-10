import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { q1, base, fermer as fermerBase } from './src/db.ts';
import {
  COOKIE, creerJeton, lireJeton, lireCookie,
  COOKIE_ADMIN, creerJetonAdmin, lireJetonAdmin, poserCookieAdmin, effacerCookieAdmin, jetonAdmin,
} from './src/session.ts';
import { forme, parSite, activite, chercher, santeDeLaBase } from './src/admin.ts';
import { autorise, adresse, purgerSeaux, REGLES } from './src/limite.ts';
import { isWallet } from './src/collectchain.ts';
import {
  declarer, rafraichir as rafraichirDecouverte, decouverteActive, lireDecouverte,
  avancement as avancementDecouverte, purgerDecouvertes,
} from './src/decouverte.ts';
import { nomsCollectibles } from './src/catalogue.ts';
import { SITE_DEFAUT, siteDeLOrigine, normaliserSite } from './src/sites.ts';
import { preparer, creerDefi, lireDefi, defiActif, rafraichir, avancement, lier, estVerifie, purgerDefis, NB_CIBLES } from './src/defi.ts';
import { creerRelais, consommerRelais, purgerRelais, DESTINATIONS } from './src/relais.ts';
import {
  creerOuLireCompte, creerOuLireCompteParEmail, lireCompteParEmail, lireCompte,
  synchroniser, avoirsDe,
  dernierSync, estAbonne, paliDe, portefeuilleOccupe, poserPortefeuille, noterAcces, demanderSuppression, annulerSuppression,
  // 🔴 LOT 122 — `accorderAbonnement` ÉTAIT IMPORTÉE ICI ET APPELÉE NULLE
  //   PART. Elle l'est désormais par `POST /admin/abonner`. `trouverCompte`
  //   l'accompagne : la page transporte la QUESTION (site + terme), pas un
  //   identifiant interne.
  purgerComptes, accorderAbonnement,
} from './src/avoirs.ts';
import { demander, consommer, purgerLiens, DUREE_MIN } from './src/lien_magique.ts';
import {
  creerCode, echanger, etatDeLaSession, revoquer, revoquerTout, purgerSessions,
} from './src/sessions.ts';
import { envoyer, courrielDeConnexion, dernierEnvoi, expediteur } from './src/courriel.ts';
import { CHAMP_PIEGE, verdict as verdictRobot, adresseRelayee } from './src/robots.ts';
import { signer, memeSecret, fabriquerCles } from './src/jetons.ts';
import { jeux, jeuConnu, retourAutorise, origineDe } from './src/jeux.ts';
import { accueil, pageChoisir, pageDefi, pageCompte, pageLienEnvoye, page, pageDecouvrir, pageDecouverte, pageAdmin } from './src/vues.ts';
import { annoncerDemarrage } from './src/demarrage.ts';

const PORT = Number(process.env.PORT ?? 3000);

/**
 * 🔴🔴 L'ADRESSE PUBLIQUE VIENT D'UNE VARIABLE, JAMAIS DE L'EN-TÊTE `Host`.
 *
 * C'est LE défaut classique des liens de connexion par courriel, et il est
 * silencieux. Construire le lien avec `req.headers.host` revient à laisser
 * l'appelant choisir où pointe le lien : une requête
 *   POST /inscription   Host: chez-moi.example
 * ferait partir, vers la VRAIE adresse de la personne, un vrai courriel à
 * notre nom, contenant un lien vers le serveur de l'attaquant — qui n'a
 * plus qu'à récupérer le jeton en clair et entrer à sa place.
 *
 * ⚠️ Le même raisonnement que `retourAutorise()` pour les jeux : une
 *    destination fournie par le client n'est pas une destination.
 *
 * ⛔ Vide, on N'ENVOIE RIEN. Le repli tentant (« prends le Host ») est
 *    exactement la faille. Le contrôle de démarrage le crie.
 */
const urlPublique = () => (process.env.URL_PUBLIQUE ?? '').replace(/\/+$/, '');
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
const brutDe = async (req: any): Promise<string> => {
  const c: Buffer[] = []; let taille = 0;
  for await (const x of req) { taille += (x as Buffer).length; if (taille > 64_000) break; c.push(x as Buffer); }
  return Buffer.concat(c).toString();
};
const corpsDe = async (req: any): Promise<URLSearchParams> => new URLSearchParams(await brutDe(req));
/** ⚠️ Ne lève jamais : un corps illisible est un corps vide, pas un 500. */
const jsonDe = async (req: any): Promise<Record<string, any>> => {
  try { const o = JSON.parse(await brutDe(req)); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
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
    /**
     * ⭐⭐⭐ LA SONDE DIT CE QUI BLOQUE — enrichie au lot 95.
     *
     * CE QUE SON ABSENCE A COÛTÉ : un envoi refusé par Brevo n'était lisible
     * que dans le journal du conteneur. De l'extérieur, la page d'inscription
     * répond « vérifiez vos e-mails » — exactement comme un succès, et c'est
     * VOULU (elle ne doit pas dire si l'adresse existe). Il fallait donc
     * ouvrir Coolify, trouver le bon onglet, savoir quoi chercher.
     *
     * ⭐ `dernier` est la trace du dernier envoi, adresses et clés MASQUÉES.
     *   C'est ce champ qui aurait dit, en une requête :
     *     « Brevo 401 : unrecognised IP address … »   puis
     *     « Brevo 400 : sender ***@*** is not valid »
     *
     * ⛔ QUE DES BOOLÉENS POUR LES SECRETS. `cle: true` dit qu'une clé est
     *   posée, jamais laquelle. L'expéditeur, lui, est déjà public : il est
     *   écrit dans l'en-tête de chaque courriel envoyé.
     */
    if (m === 'GET' && p === '/sante') return json(res, {
      ok: true,
      at: new Date().toISOString(),
      courriel: {
        cle: Boolean(process.env.BREVO_CLE),
        simule: process.env.COURRIEL_SIMULE === '1',
        expediteur: expediteur(),
        url_publique: Boolean(process.env.URL_PUBLIQUE),
        dernier: dernierEnvoi(),
      },
      sites: [...jeux().keys()],
      /**
       * 🔥 LOT 108 — CE QUE LA BASE DÉCLARE, DE L'EXTÉRIEUR, EN UNE REQUÊTE.
       *
       * CE QUE SON ABSENCE A COÛTÉ LE 07/08 : après le dépôt du lot 107, la
       * seule façon de savoir si la migration avait eu lieu était d'ouvrir
       * Coolify, de trouver l'onglet des journaux du CONTENEUR (pas celui du
       * déploiement) et de savoir quoi chercher. On a conclu « non prouvé »
       * d'une ligne qui n'était pas encore écrite.
       *
       * ⛔ QUE DES BOOLÉENS ET UN COMPTAGE — même règle que pour les secrets
       *    au lot 95. `site_present` dit qu'une colonne existe ; il ne dit
       *    ni combien de comptes, ni lesquels, ni sur quels sites. La forme
       *    d'un schéma n'identifie personne ; sa population, si.
       */
      base: santeDeLaBase(),
      // ⭐ LES DESTINATIONS DU RELAIS SONT PUBLIQUES, ET C'EST VOULU : elles
      // ne révèlent rien (deux chemins de ce service) et elles répondent à
      // la seule question qu'un site se pose en intégrant la passerelle —
      // « quelles valeurs de `vers` acceptes-tu ? ». Sans ça, la réponse
      // vit dans un fichier d'un autre dépôt, et se périme en silence.
      relais: Object.keys(DESTINATIONS),
    });

    /**
     * ⭐⭐ LA ROUTE QUE LE MIDDLEWARE DE veve-sites ATTEND DEPUIS LE LOT 42.
     *
     *     GET /session/<sid>  ->  { "palier": "member" }
     *
     * 🔴 ELLE EST **PUBLIQUE**, ET TRAITÉE ICI, AVANT `/api/`. Deux raisons
     *    qui n'ont rien à voir l'une avec l'autre :
     *
     *  1. Le middleware n'envoie pas `x-service` — il n'a aucun secret à
     *     porter, c'est un processus qui rend des pages. Ce qui protège
     *     cette lecture, c'est que le `sid` est tiré sur 256 bits.
     *  2. Elle ne rend QUE le palier. Un palier n'identifie personne. Le
     *     jour où on lui fera rendre l'adresse « pour afficher le nom dans
     *     l'en-tête », il faudra la fermer — parce qu'elle cessera de ne
     *     rien révéler.
     *
     * ⚠️ Un `sid` inconnu rend **404 avec un corps JSON**, pas une page
     *    HTML : le middleware lit `r.ok` puis `r.json()`, et une
     *    redirection vers l'accueil lui donnerait du HTML à parser.
     */
    if (m === 'GET' && p.startsWith('/session/')) {
      if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
      const e = etatDeLaSession(decodeURIComponent(p.slice('/session/'.length)));
      if (!e.palier) return json(res, { erreur: 'session inconnue' }, 404);
      return json(res, { palier: e.palier });
    }

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

      /**
       * ⭐⭐ LES TROIS ROUTES DU LOT 90 — traitées AVANT `?compte=`.
       *
       * ⚠️ Le bloc d'origine lit `?compte=` et rend 404 s'il est absent.
       *    Ces trois-là n'ont pas de compte à fournir : c'est justement
       *    leur objet d'en trouver un. Posées plus bas, elles auraient
       *    rendu « compte inconnu » sur une inscription parfaitement
       *    valide — un 404 qui accuse la mauvaise chose.
       */

      /**
       * L'inscription RELAYÉE. veveprice garde son formulaire, son thème
       * et son domaine ; c'est lui qui appelle, côté serveur.
       *
       * 🔴 LA RÉPONSE EST LA MÊME DANS TOUS LES CAS — adresse neuve, déjà
       *    inscrite, trop de demandes, envoi en panne. Le relais ne doit
       *    RIEN pouvoir apprendre de plus qu'un visiteur : sinon la
       *    précaution prise sur la page publique ne vaut plus rien, il
       *    suffirait de regarder ce que le relais reçoit.
       */
      if (m === 'POST' && p === '/api/inscription') {
        const b = await jsonDe(req);
        /**
         * 🔴🔴 L'ADRESSE DU VISITEUR, PAS CELLE DU RELAIS — corrigé au lot 95.
         *
         * `trop()` indexe son seau sur `adresse()`, qui rend l'adresse de la
         * CONNEXION. Derrière le relais de veveprice, c'est l'adresse de
         * veveprice — la même pour tout le monde.
         * ⇒ **5 inscriptions par 10 minutes pour la Terre entière.**
         *
         * Ce n'était pas une protection contre les robots : c'était une panne
         * à partir du sixième inscrit, et un seul robot suffisait à fermer la
         * porte à tous les autres.
         *
         * ⭐ On peut croire cet en-tête ICI et nulle part ailleurs : la
         *   requête a déjà présenté `x-service`. Ce n'est pas « un en-tête
         *   qu'on croit », c'est « une information transmise par un service
         *   identifié ». Le contrôle du secret est dix lignes plus haut.
         */
        const vraie = adresseRelayee(req.headers['x-client-ip']);
        const seau = `${vraie ?? ip}|inscription`;
        if (!autorise(seau, REGLES.verifier)) return json(res, { erreur: 'trop de demandes' }, 429);

        /**
         * ⛔⛔ ON NE REVÉRIFIE PAS ICI LE SCEAU DU RELAIS — et c'est un banc
         *     rouge qui l'a imposé.
         *
         * Ma première version faisait vérifier par veveid le sceau signé par
         * veveprice. Les deux le signaient avec un secret différent
         * (`SESSION_SECRET` ici, `VEVEID_SERVICE` là-bas) : TOUTE inscription
         * relayée était écartée pour « sceau invalide ». Une protection qui
         * bloque 100 % des humains et 100 % des robots n'est pas stricte,
         * elle est cassée.
         *
         * ⭐⭐⭐ ET LA VRAIE LEÇON EST PLUS PROFONDE QUE LE RÉGLAGE : **UN SCEAU
         *   NE SE VÉRIFIE QUE PAR CELUI QUI L'A ÉMIS.** Le faire contrôler par
         *   un tiers, c'est inventer un second secret partagé sans le dire —
         *   et un secret qu'on n'a pas décidé de partager n'est jamais posé
         *   des deux côtés.
         *
         * ⭐ CE QUI PROTÈGE CETTE ROUTE, ET C'EST SUFFISANT :
         *   · `x-service` — l'appelant est identifié, il répond de ses
         *     visiteurs et applique SES garde-fous sur SON formulaire ;
         *   · le limiteur par ADRESSE DU VISITEUR, juste au-dessus ;
         *   · le limiteur par ADRESSE E-MAIL (3 / 15 min, `lien_magique.ts`) —
         *     celui-là est incontournable, et c'est LUI qui empêche de
         *     bombarder un tiers.
         */
        const email = String(b.email ?? '');
        const retourDemande = String(b.retour ?? '');
        const site = String(b.site ?? '');

        /**
         * 🔴 LE MÊME CONTRÔLE QUE POUR LES JEUX, ET POUR LA MÊME RAISON.
         *    Sans lui, quiconque connaît `ID_SERVICE` ferait envoyer, à
         *    l'adresse de son choix, un courriel à notre nom dont le lien
         *    ramène chez lui. `retourAutorise()` compare des ORIGINES,
         *    pas des préfixes.
         */
        let retour: string | null = null;
        if (retourDemande) {
          if (!jeuConnu(site) || !retourAutorise(site, retourDemande))
            return json(res, { erreur: 'adresse de retour refusée' }, 400);
          retour = retourDemande;
        }
        if (!urlPublique()) {
          console.error('[inscription] URL_PUBLIQUE absente : aucun lien ne peut être fabriqué.');
          return json(res, { erreur: 'service indisponible' }, 503);
        }
        const d = demander(email, { retour });
        if (d.erreur && !d.jeton && d.erreur.startsWith('Cette adresse'))
          return json(res, { erreur: 'adresse invalide' }, 400);
        if (d.jeton) {
          const lien = `${urlPublique()}/entrer-par-lien?j=${encodeURIComponent(d.jeton)}`;
          // ⚠️ « neuf » sert UNIQUEMENT au ton du courriel (bienvenue ou
          //    retour). Il se lit donc dans le cloisonnement du site d'où vient
          //    la demande : la même adresse peut être neuve ici et connue
          //    ailleurs, et c'est exactement ce que l'isolation veut dire.
          const neuf = !lireCompteParEmail(normaliserSite(site), email);
          const bilan = await envoyer(courrielDeConnexion(email.trim().toLowerCase(), lien, DUREE_MIN, neuf));
          if (!bilan.ok) console.error(`[inscription] envoi refusé : ${bilan.pourquoi}`);
          else console.log(`[inscription] lien envoyé (relais${site ? ' ' + site : ''})${bilan.simule ? ' SIMULÉ' : ''}`);
        } else console.warn(`[inscription] lien non fabriqué : ${d.erreur}`);
        return json(res, { ok: true });
      }

      /**
       * L'ÉCHANGE. Le code arrive par l'URL du navigateur, mais il est
       * échangé ICI, de serveur à serveur : le `sid` ne traverse jamais un
       * navigateur autrement que dans un cookie `HttpOnly`.
       */
      if (m === 'POST' && p === '/api/echange') {
        if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
        const b = await jsonDe(req);
        const e = echanger(String(b.code ?? ''));
        if (!e.sid) return json(res, { erreur: e.pourquoi ?? 'code invalide' }, 400);
        return json(res, { sid: e.sid, palier: e.palier, compte: e.compte, email: e.email });
      }

      /**
       * ⭐ LA DÉCONNEXION EST UNE RÉVOCATION, PAS UN COOKIE EFFACÉ. Effacer
       *    le cookie côté site laisse la session ouverte chez nous : elle
       *    rouvrirait pour qui aurait copié le `sid`. On ferme à la source.
       */
      if (m === 'POST' && p === '/api/deconnexion') {
        const b = await jsonDe(req);
        return json(res, { ok: revoquer(String(b.sid ?? '')) });
      }

      /**
       * ═══════════════════════════════════════════════════════════════
       * ⭐⭐⭐ LES TROIS ROUTES DU LOT 99 — le site parle POUR un membre.
       * ═══════════════════════════════════════════════════════════════
       * Elles sont ici, AVANT `?compte=`, pour la même raison que celles
       * du lot 90 : elles ne portent pas d'identifiant de compte, elles
       * portent un `sid`. Posées plus bas, elles auraient rendu « compte
       * inconnu » sur une session parfaitement valide.
       *
       * 🔴 POURQUOI LE `sid` ET PAS LE `?compte=`. Le site ne DÉTIENT pas
       *    l'identifiant du compte : il a un cookie de session, et c'est
       *    tout. Lui faire porter l'identifiant reviendrait à le laisser
       *    DÉSIGNER un compte — avec le secret de service, il pourrait
       *    lire ou supprimer n'importe lequel. Ici il ne peut agir que
       *    sur la session qu'il a réellement en main, et c'est veveid qui
       *    la résout.
       * ⭐⭐ LE SECRET DE SERVICE DIT « TU ES UN SITE », PAS « TU ES CETTE
       *    PERSONNE ». Les deux preuves sont exigées ensemble.
       */

      /**
       * L'état du compte pour la page « Mon compte » d'un site.
       *
       * ⚠️ ELLE EST SÉPARÉE DE `/session/<sid>`, QUI RESTE PUBLIQUE ET NE
       *    REND QUE LE PALIER. Son commentaire l'annonçait : « si un jour
       *    on lui fait rendre l'adresse e-mail, il faudra la fermer ».
       *    On ne l'a pas fermée — on a ouvert une AUTRE porte, gardée par
       *    le secret de service. Le middleware, lui, continue d'appeler la
       *    route publique à chaque page rendue, sans rien porter.
       */
      if (m === 'GET' && p === '/api/session') {
        if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
        const e = etatDeLaSession(url.searchParams.get('sid') ?? '');
        if (!e.compte) return json(res, { erreur: 'session inconnue' }, 404);
        const k = lireCompte(e.compte);
        if (!k) return json(res, { erreur: 'session inconnue' }, 404);
        return json(res, {
          compte: k.id, email: k.email, palier: e.palier,
          wallet: k.wallet ?? null, verifie: !!k.verifie, verifie_le: k.verifie_le ?? null,
          abonne: estAbonne(k) ? k.abonne_jusqu_a : null,
          cree_le: k.cree_le,
          // ⭐ Toujours `false` ici, et ce n'est pas un oubli :
          // `etatDeLaSession` ferme la porte dès qu'une suppression est
          // demandée. Le champ existe pour que le site n'ait pas à deviner
          // ce que veut dire un 404 — il le lira le jour où la règle
          // changera, sans qu'on ait à modifier deux dépôts.
          supprime: !!k.supprime_le,
        });
      }

      /**
       * ⭐⭐ LE RELAIS — faire entrer ICI quelqu'un qui est connecté LÀ-BAS.
       * Le site demande un jeton pour SA session ; on rend une adresse
       * complète, à ouvrir dans le navigateur de la personne.
       * ⛔ On ne rend pas le jeton nu : le site n'a rien à en faire d'autre
       *    que de rediriger, et une adresse complète interdit qu'il se
       *    fabrique une destination.
       */
      if (m === 'POST' && p === '/api/passerelle') {
        if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
        const b = await jsonDe(req);
        const e = etatDeLaSession(String(b.sid ?? ''));
        if (!e.compte) return json(res, { erreur: 'session inconnue' }, 404);
        const vers_ = String(b.vers ?? 'compte');
        const jeton = creerRelais(e.compte, vers_);
        if (!jeton) return json(res, { erreur: `destination inconnue : ${vers_}` }, 400);
        const base = String(process.env.URL_PUBLIQUE ?? '').replace(/\/$/, '');
        // 🔴 SANS `URL_PUBLIQUE`, ON NE DEVINE PAS. Se rabattre sur l'en-tête
        // `Host` enverrait la personne chez qui a fait la requête — c'est la
        // même faute que le lien de connexion refuse déjà de commettre.
        if (!base) return json(res, { erreur: 'URL_PUBLIQUE absente' }, 500);
        return json(res, { url: `${base}/entrer-par-relais?r=${encodeURIComponent(jeton)}` });
      }

      /**
       * 🔴 LA SUPPRESSION DEMANDÉE DEPUIS UN SITE.
       * ⭐ Elle ne fait qu'appeler ce qui existait déjà : le délai de grâce,
       *   la révocation de toutes les sessions, l'effacement différé. On
       *   n'a pas écrit une deuxième suppression « pour les sites » — il y
       *   en aurait eu deux à corriger le jour d'une erreur.
       * ⚠️ CONSÉQUENCE À CONNAÎTRE, ET À DIRE À LA PERSONNE :
       *   `etatDeLaSession` refuse un compte marqué supprimé. La session
       *   du site meurt donc DANS LA SECONDE — c'est-à-dire qu'on ne
       *   pourra PAS annuler depuis le site. L'annulation vit ici, sur ce
       *   service, avec un lien de connexion par courriel.
       */
      if (m === 'POST' && p === '/api/supprimer') {
        if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
        const b = await jsonDe(req);
        const e = etatDeLaSession(String(b.sid ?? ''));
        if (!e.compte) return json(res, { erreur: 'session inconnue' }, 404);
        /**
         * ⭐⭐ LA CONFIRMATION SE VÉRIFIE ICI, PAS SUR LE SITE.
         * MightysArena demandait de recopier son adresse de portefeuille ;
         * le principe est le même : un geste destructeur exige de RECOPIER
         * quelque chose, pas de cliquer un bouton de plus. Mais le site ne
         * doit pas être le juge — il ne connaît l'adresse que parce qu'on
         * la lui a dite, et un contrôle fait par celui qui détient déjà la
         * réponse ne prouve rien.
         * ⛔ Comparaison insensible à la casse et aux espaces : refuser une
         *   suppression pour une majuscule serait une frustration gratuite.
         */
        const k = lireCompte(e.compte);
        const attendu = String(k?.email ?? '').trim().toLowerCase();
        const fourni = String(b.confirmation ?? '').trim().toLowerCase();
        if (!attendu || fourni !== attendu)
          return json(res, { ok: false, message: 'La confirmation ne correspond pas à l’adresse du compte.' }, 400);
        const bilan = demanderSuppression(e.compte);
        if (bilan.ok) revoquerTout(e.compte);
        return json(res, bilan);
      }

      const c = lireCompte(url.searchParams.get('compte') ?? '');
      /**
       * 🔴 CORRIGÉ AU LOT 89 : le contrôle était `!c || !c.verifie`.
       *    `verifie` dit « le PORTEFEUILLE est prouvé », pas « le compte
       *    est valide » — depuis que l'inscription se fait par courriel,
       *    un membre parfaitement légitime a `verifie = 0`, et l'API
       *    répondait « compte inconnu » sur un compte qu'elle venait de
       *    lire. On sépare donc les deux questions.
       */
      if (!c) return json(res, { erreur: 'compte inconnu' }, 404);
      if (p === '/api/avoirs' && !c.verifie)
        return json(res, { erreur: 'portefeuille non vérifié' }, 409);
      if (p === '/api/avoirs') return json(res, {
        compte: c.id, wallet: c.wallet,
        abonne: estAbonne(c) ? c.abonne_jusqu_a : null,
        supprime: !!c.supprime_le,
        avoirs: avoirsDe(c.id),
        sync: dernierSync(c.id) ?? null,
      });
      /**
       * ⭐ `palier` est ajouté ici (lot 89) parce que c'est CE service qui
       *    connaît l'abonnement. Le middleware de veve-sites attend un
       *    palier ; le lui faire déduire de `abonne` ailleurs, ce serait
       *    écrire la même règle à deux endroits — et le jour où un palier
       *    s'ajoute, seul l'un des deux le saurait.
       *
       * ⛔ On garde `abonne` : un consommateur existant ne doit pas casser.
       */
      if (p === '/api/compte') return json(res, {
        compte: c.id, wallet: c.wallet, email: c.email,
        palier: paliDe(c),
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

    // ═══════════════════════════════════════════════════════════════════
    // 🔥 LOT 108 — L'EXPLOITATION
    // ═══════════════════════════════════════════════════════════════════
    /**
     * ⚠️ PLACÉ ICI, ET PAS PLUS BAS. Sous la ligne
     *   `const compte = compteId ? … ; if (!compte) return … vers(res, '/')`
     * ces routes seraient avalées : un administrateur n'a pas de compte
     * joueur, il serait renvoyé à l'accueil sans un mot. Le symptôme aurait
     * ressemblé à « le lot n'est pas déposé ».
     *
     * ⭐⭐⭐ ET QUAND LE JETON EST ABSENT OU FAUX, ON NE RÉPOND PAS : ON NE
     * TRAITE PAS. Aucun `return`, donc la requête RETOMBE dans le flux
     * normal et finit en 302 vers `/` — exactement, à l'octet près, ce que
     * rend n'importe quelle adresse inexistante de ce service.
     * ⛔ Un 404 aurait été une réponse UNIQUE à cette adresse : il aurait
     *    annoncé « il y a quelque chose ici, mais pas pour vous ». Un 401
     *    encore plus. La seule réponse qui n'apprend rien est celle que tout
     *    le monde reçoit déjà.
     */
    if (p === '/admin' || p.startsWith('/admin/')) {
      const attendu = jetonAdmin();
      /**
       * ⚠️ `trop()` rend VRAI quand le plafond est DÉPASSÉ. On traite donc
       *    quand `!trop(...)`. Écrite à l'envers, cette condition n'aurait
       *    ouvert la page qu'au-DELÀ du plafond : verte à l'usage normal,
       *    donc invisible, et l'inverse exact de ce qui est écrit au-dessus.
       * ⭐ Un plafond dépassé se comporte comme un jeton absent : on ne
       *    traite pas, on retombe.
       */
      if (attendu && !trop(REGLES.admin)) {
        const k = url.searchParams.get('k');
        /**
         * ⭐ L'ÉCHANGE : le jeton d'URL contre un cookie, puis on NETTOIE
         *    l'URL par une redirection. Sans ce second geste, le secret
         *    resterait dans la barre d'adresse, donc dans l'historique et
         *    dans l'en-tête `Referer` de tout lien cliqué depuis la page.
         *    ⚠️ La redirection est ce qui rend l'échange utile — pas le
         *    cookie. Les deux ou rien.
         */
        if (m === 'GET' && p === '/admin' && k) {
          if (!memeSecret(k, attendu)) return vers(res, '/');
          return vers(res, '/admin', { 'set-cookie': poserCookieAdmin(creerJetonAdmin(attendu)) });
        }

        const ouvert = lireJetonAdmin(lireCookie(req.headers.cookie, COOKIE_ADMIN), attendu);
        if (ouvert) {
          if (m === 'POST' && p === '/admin/sortir')
            return vers(res, '/', { 'set-cookie': effacerCookieAdmin() });

          if (m === 'POST' && p === '/admin/chercher') {
            const b = await corpsDe(req);
            /**
             * ⚠️ POST, ET PAS UNE RECHERCHE PAR `?q=`. Le terme cherché est
             *    une adresse e-mail ou un portefeuille : dans une URL il
             *    partirait dans l'historique, dans le journal du proxy et
             *    dans le `Referer`. Une page d'exploitation qui dépose des
             *    identités dans trois journaux annule ce qu'elle protège.
             */
            const t = chercher(String(b.get('q') ?? ''));
            // ⛔ Le terme n'est PAS journalisé — seulement le fait qu'on a cherché.
            console.log(`[admin] recherche (${t.quoi}) : ${t.trouve ? 'trouvé' : 'rien'}`);
            return html(res, pageAdmin(forme(), parSite(), activite(), t));
          }

          /**
           * ═══════════════════════════════════════════════════════════════
           * 🔴🔴🔴 LOT 122 — ACCORDER UN ABONNEMENT. LE CIRCUIT SE FERME.
           * ═══════════════════════════════════════════════════════════════
           * CE QUE ÇA RÉPARE, ET C'EST PLUS GRAND QU'UNE FONCTIONNALITÉ.
           * `accorderAbonnement()` existe depuis des semaines et n'était
           * appelée par PERSONNE en dehors des tests. Le palier `crevette`
           * se gagne par `abonne_jusqu_a > maintenant` — donc AUCUN COMPTE AU
           * MONDE ne pouvait l'atteindre, et tout ce que veveprice vend
           * (`/market/`, l'historique 7 j/30 j, les extrêmes, les modules,
           * les alertes) était fermé à 100 % des humains ET à 100 % des
           * robots. Une protection qui bloque tout le monde n'est pas
           * stricte : elle est cassée. De l'extérieur, les deux se
           * ressemblent exactement.
           *
           * ⭐⭐⭐ ET LE PIÈGE QUI L'A FAIT DURER : `server.ts` IMPORTAIT la
           * fonction (l. 24) sans jamais l'appeler. Un `grep` la trouvait
           * ici, dans le fichier des routes — de quoi conclure qu'elle était
           * branchée. *Un import sans appel est un faux positif pour toute
           * recherche : il met la preuve au mauvais endroit.*
           *
           * ⛔ TROIS GARDE-FOUS, ET AUCUN N'EST DÉCORATIF :
           *   1. le bloc `/admin` entier exige déjà le cookie d'exploitation
           *      et passe par `trop(REGLES.admin)` — rien n'est assoupli ;
           *   2. le nombre de jours est BORNÉ (1..400). Sans borne, une faute
           *      de frappe accorde un siècle, et rien ne le dit ;
           *   3. le compte est RETROUVÉ par (site, terme), pas désigné par un
           *      identifiant transporté dans la page.
           * ⭐ La trace dit le SITE et la DURÉE, jamais le terme cherché —
           *   même règle que la recherche juste au-dessus.
           */
          if (m === 'POST' && p === '/admin/abonner') {
            const b = await corpsDe(req);
            // ⭐ UNE RÉFÉRENCE OPAQUE, PAS LE TERME CHERCHÉ. Ma première
            //   version renvoyait l'e-mail dans un champ caché ;
            //   `test/admin.test.ts` l'a refusée — « aucune identité en clair
            //   dans le HTML », vérifié SUR LA SORTIE. Le banc avait raison
            //   contre moi, et c'est le code qui a changé.
            const ref = String(b.get('ref') ?? '');
            const jours = Number(b.get('jours') ?? 0);
            let message: string;
            // ⚠️ `Number.isInteger` ET les bornes : `Number('30j')` rend NaN,
            //    `Number('')` rend 0, et `NaN > 0` est faux — mais `NaN` passe
            //    un `!jours` par la bande dans d'autres écritures. On exige la
            //    forme, on ne la devine pas.
            if (!Number.isInteger(jours) || jours < 1 || jours > 400) {
              message = 'Durée refusée : un entier de 1 à 400 jours.';
            } else {
              // ⭐ `accorderAbonnement` VÉRIFIE elle-même que le compte existe
              //   et rend « Compte inconnu. » sinon : on ne redouble pas le
              //   contrôle ici. Deux vérifications de la même chose finissent
              //   par diverger, et c'est la plus permissive qui gagne.
              message = accorderAbonnement(ref, jours);
            }
            // ⛔ NI LA RÉFÉRENCE NI LE TERME DANS LA TRACE : on journalise le
            //   FAIT, jamais QUI. Même règle que la recherche au-dessus.
            console.log(`[admin] abonnement (${jours} j) : ${message}`);
            // ⚠️ On ne réaffiche PAS le résultat de recherche : on n'a plus le
            //   terme, et c'est voulu. La page revient à son état neutre avec
            //   le message — une page d'exploitation qui garde une identité à
            //   l'écran après le geste est une identité de plus qui traîne.
            return html(res, pageAdmin(forme(), parSite(), activite(), undefined, message));
          }

          if (m === 'GET' && p === '/admin')
            return html(res, pageAdmin(forme(), parSite(), activite()));
        }
      }
      // ⇩ aucune des conditions n'a rendu : on retombe dans le flux normal.
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
      const c = creerOuLireCompte(siteDeLOrigine(retour) ?? SITE_DEFAUT(), wallet);
      /**
       * ⚠️ `Secure` AJOUTÉ AU LOT 89. Il manquait ici alors qu'il est
       *    présent dans `poserCookie()` (session.ts) depuis le début :
       *    cette route posait donc un cookie de session que le navigateur
       *    accepte de renvoyer en clair sur une requête http. Défaut
       *    préexistant, sans rapport avec l'inscription — trouvé en
       *    comparant les deux endroits qui posent le même cookie.
       */
      return vers(res, c.verifie ? '/compte' : '/choisir', {
        'set-cookie': `${COOKIE}=${creerJeton(c.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`,
      });
    }

    /**
     * ⭐⭐ L'INSCRIPTION PAR COURRIEL — placée ICI, et l'endroit compte.
     *
     * 🔴 Trois lignes plus bas commence le mur « pas de session ⇒ retour à
     *    l'accueil ». Une route d'inscription posée APRÈS ce mur serait
     *    inatteignable par la seule personne à qui elle s'adresse : celle
     *    qui n'a pas encore de compte. Le symptôme aurait été une
     *    redirection vers `/`, donc « le formulaire ne fait rien ».
     */
    if (m === 'POST' && p === '/inscription') {
      /**
       * ⚠️ DEUX LIMITEURS, PAS UN. Celui-ci est par adresse IP ; celui de
       *    `lien_magique.demander()` est par adresse e-mail. Le premier
       *    protège notre quota d'envoi, le second empêche de harceler
       *    quelqu'un dont on connaît l'adresse — un seul des deux laisse
       *    l'autre attaque ouverte.
       */
      if (trop(REGLES.verifier))
        return html(res, accueil(undefined, 'Trop de demandes depuis cette connexion. Patientez quelques minutes.'), 429);
      const b = await corpsDe(req);
      const email = String(b.get('email') ?? '');

      /**
       * ⭐ CHAMP PIÈGE ET DÉLAI MINIMUM — voir `robots.ts` pour le pourquoi.
       * ⛔ ON REND LA MÊME PAGE QU'UN SUCCÈS. Dire « vous êtes un robot »
       *   apprendrait à l'auteur ce qui l'a trahi, donc comment corriger.
       *   Le journal, lui, a le droit de savoir.
       */
      const vr = verdictRobot(b.get(CHAMP_PIEGE), b.get('sceau'));
      if (!vr.ok) {
        console.warn(`[inscription] écarté : ${vr.pourquoi}`);
        return html(res, pageLienEnvoye(DUREE_MIN));
      }

      if (!urlPublique()) {
        console.error('[inscription] URL_PUBLIQUE absente : aucun lien ne peut être fabriqué.');
        return html(res, accueil(undefined, 'L’inscription est momentanément indisponible.'), 500);
      }

      const d = demander(email);
      /**
       * 🔴 MÊME RÉPONSE DANS TOUS LES CAS — succès, adresse déjà inscrite,
       *    trop de demandes pour cette adresse, envoi en panne. Seule
       *    l'adresse manifestement impossible reçoit une vraie erreur, et
       *    elle ne renseigne sur personne.
       *
       * ⭐ Le coût est réel : Preda ne verra pas dans son navigateur qu'un
       *    envoi a échoué. C'est pour ça que l'échec est JOURNALISÉ avec sa
       *    phrase d'origine — l'information existe, elle est juste au bon
       *    endroit.
       */
      if (d.erreur && !d.jeton && d.erreur.startsWith('Cette adresse'))
        return html(res, accueil(undefined, d.erreur), 400);

      if (d.jeton) {
        const lien = `${urlPublique()}/entrer-par-lien?j=${encodeURIComponent(d.jeton)}`;
        const neuf = !lireCompteParEmail(siteDeLOrigine(retour) ?? SITE_DEFAUT(), email);
        const bilan = await envoyer(courrielDeConnexion(email.trim().toLowerCase(), lien, DUREE_MIN, neuf));
        if (!bilan.ok) console.error(`[inscription] envoi refusé : ${bilan.pourquoi}`);
        else console.log(`[inscription] lien envoyé${bilan.simule ? ' (SIMULÉ)' : ''}${bilan.id ? ` — ${bilan.id}` : ''}`);
      } else {
        console.warn(`[inscription] lien non fabriqué : ${d.erreur}`);
      }
      return html(res, pageLienEnvoye(DUREE_MIN));
    }

    /**
     * ⭐ LA CONSOMMATION DU LIEN. C'est le seul endroit du service où une
     *    session naît sans portefeuille.
     *
     * ⚠️ Le jeton voyage dans l'URL — il n'y a pas d'autre façon de le
     *    mettre dans un courriel. Il est donc court (quinze minutes) ET à
     *    usage unique, et on NETTOIE l'URL par une redirection dès qu'il a
     *    servi : sans ça il resterait dans l'historique du navigateur et
     *    dans l'en-tête `Referer` de chaque lien cliqué depuis la page.
     */
    /**
     * ⭐⭐ LA PORTE DU RELAIS — publique, comme `/entrer-par-lien`, et pour
     * la même raison : c'est le NAVIGATEUR de la personne qui l'ouvre, et
     * un navigateur ne porte pas le secret de service.
     * ⭐ Ce qui la protège est le jeton : 256 bits, une minute, un usage.
     * ⛔ Elle est placée AVANT la porte de session (`if (!compte)`), sinon
     *   elle renverrait vers l'accueil exactement les gens qu'elle existe
     *   pour faire entrer — la boucle de redirections du lot 89, remise au
     *   goût du jour.
     */
    if (m === 'GET' && p === '/entrer-par-relais') {
      if (trop(REGLES.verifier))
        return html(res, accueil(undefined, 'Trop de tentatives. Patientez quelques minutes.'), 429);
      const v = consommerRelais(url.searchParams.get('r') ?? '');
      if (!v.compteId) return html(res, accueil(undefined, v.pourquoi), 400);
      return vers(res, v.chemin ?? '/compte', {
        'set-cookie': `${COOKIE}=${creerJeton(v.compteId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`,
      });
    }

    if (m === 'GET' && p === '/entrer-par-lien') {
      if (trop(REGLES.verifier))
        return html(res, accueil(undefined, 'Trop de tentatives. Patientez quelques minutes.'), 429);
      const v = consommer(url.searchParams.get('j') ?? '');
      if (!v.email) return html(res, accueil(undefined, v.pourquoi), 400);
      const c = creerOuLireCompteParEmail(siteDeLOrigine(v.retour) ?? SITE_DEFAUT(), v.email);
      const cookie = `${COOKIE}=${creerJeton(c.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`;

      /**
       * ⭐⭐ LE RETOUR VERS LE SITE QUI A INSCRIT LA PERSONNE (lot 90).
       *
       * ⚠️ On NE remet PAS `retourAutorise()` ici. L'adresse a été
       *    contrôlée au moment de la demande, avant d'être écrite. La
       *    revérifier donnerait deux endroits où la même règle peut
       *    diverger ; et c'est toujours celui qu'on a oublié qui sert.
       *    Ce qui compte, c'est qu'AUCUN chemin n'écrive `retour` sans
       *    l'avoir contrôlé — il n'y en a qu'un, dans `/api/inscription`.
       *
       * ⭐ On pose QUAND MÊME le cookie veveid : la personne peut revenir
       *    plus tard sur `/compte` pour vérifier son portefeuille, sans
       *    redemander un lien.
       */
      if (v.retour) {
        const u = new URL(v.retour);
        u.searchParams.set('code', creerCode(c.id));
        return vers(res, u.toString(), { 'set-cookie': cookie });
      }
      return vers(res, '/compte', { 'set-cookie': cookie });
    }

    const compte = compteId ? lireCompte(compteId) : undefined;
    if (!compte) return m === 'GET' && p === '/' ? html(res, accueil()) : vers(res, '/');

    if (m === 'GET' && p === '/deconnexion')
      return vers(res, '/', { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });

    /**
     * ⭐ Lier un portefeuille APRÈS coup, depuis « Mon compte ». C'est la
     *    seule façon pour un membre inscrit par courriel d'entrer dans le
     *    parcours de vérification, qui part du portefeuille.
     */
    if (m === 'POST' && p === '/lier-portefeuille') {
      if (compte.verifie) return vers(res, '/compte');
      if (trop(REGLES.verifier))
        return vers(res, '/compte?msg=' + encodeURIComponent('Trop de tentatives. Patientez quelques minutes.'));
      const b = await corpsDe(req);
      const w = String(b.get('wallet') ?? '').trim().toLowerCase();
      if (!isWallet(w))
        return vers(res, '/compte?msg=' + encodeURIComponent('Adresse invalide : elle commence par 0x et fait 42 caractères.'));
      /**
       * ⚠️ On refuse AVANT d'écrire si un autre compte porte déjà ce
       *    portefeuille et a quelque chose à perdre. `lier()` refait ce
       *    contrôle au moment de la preuve — les deux sont utiles : ici on
       *    évite de faire mettre deux collectibles en vente pour rien.
       */
      const occupe = portefeuilleOccupe(compte.site, w, compte.id);
      if (occupe) return vers(res, '/compte?msg=' + encodeURIComponent('Ce portefeuille est déjà lié à un autre compte.'));
      poserPortefeuille(compte.id, w);
      return vers(res, '/choisir');
    }

    // ── La vérification ─────────────────────────────────────────────────
    if (m === 'GET' && p === '/choisir') {
      if (compte.verifie) return vers(res, '/compte');
      /**
       * 🔴 SANS PORTEFEUILLE, IL N'Y A RIEN À VÉRIFIER. `preparer(null)`
       *    serait parti lire la chaîne pour une adresse vide — une requête
       *    à l'explorateur, sur notre quota, pour une réponse qui ne peut
       *    qu'être vide. On renvoie à la page qui pose la question.
       */
      if (!compte.wallet) return vers(res, '/compte');
      if (defiActif(compte.wallet)) return vers(res, '/verification');
      if (trop(REGLES.verifier)) return html(res, pageChoisir({}, 'Trop de lectures. Patientez une minute.'), 429);
      const e = await preparer(compte.wallet);
      return html(res, pageChoisir(e, e.erreur));
    }
    if (m === 'POST' && p === '/choisir') {
      if (compte.verifie) return vers(res, '/compte');
      if (!compte.wallet) return vers(res, '/compte');
      const b = await corpsDe(req);
      const { defi, erreur } = await creerDefi(compte.wallet, compte.id, b.getAll('t').slice(0, NB_CIBLES + 4));
      if (erreur || !defi) return html(res, pageChoisir(await preparer(compte.wallet), erreur), 400);
      return vers(res, '/verification');
    }
    if (m === 'GET' && p === '/verification') {
      if (compte.verifie) return vers(res, '/compte');
      if (!compte.wallet) return vers(res, '/compte');
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
    // ═══════════════════════════════════════════════════════════════════
    // 🔥 LOT 106 — RETROUVER SON PORTEFEUILLE SANS CONNAÎTRE SON ADRESSE
    // ═══════════════════════════════════════════════════════════════════
    // ⛔ CES ROUTES NE DEMANDENT JAMAIS `compte.wallet`, contrairement à
    //    `/choisir` et `/verification` : ici l'adresse est ce qu'on CHERCHE.
    //    C'est la seule différence de fond entre les deux parcours.
    if (m === 'GET' && p === '/decouvrir') {
      if (compte.verifie) return vers(res, '/compte');
      if (decouverteActive(compte.id)) return vers(res, '/decouverte');
      return html(res, pageDecouvrir(url.searchParams.get('msg') ?? undefined));
    }
    if (m === 'POST' && p === '/decouvrir') {
      if (compte.verifie) return vers(res, '/compte');
      if (trop(REGLES.verifier)) return html(res, pageDecouvrir('Trop de tentatives. Patientez une minute.'), 429);
      const b = await corpsDe(req);
      // ⚠️ Les champs arrivent APPARIÉS PAR LEUR ORDRE : nom[i] va avec
      //    edition[i]. Un formulaire réordonné donnerait des paires fausses
      //    mais plausibles — jamais retrouvées sur la chaîne, et illisibles
      //    pour la personne. C'est le gabarit qui garantit l'ordre.
      const noms = b.getAll('nom').map((x) => String(x));
      const eds = b.getAll('edition').map((x) => String(x));
      const paires = noms.map((nom, i) => ({ nom, edition: Number.parseInt(eds[i] ?? '', 10) }));
      const r = await declarer(compte.id, paires);
      if (!r.decouverte)
        return html(res, pageDecouvrir(r.erreur, noms.map((nom, i) => ({ nom, edition: eds[i] }))), 400);
      return vers(res, '/decouverte');
    }
    if (m === 'GET' && p === '/decouverte') {
      if (compte.verifie) return vers(res, '/compte');
      const d = decouverteActive(compte.id);
      if (!d) return vers(res, '/decouvrir');
      return html(res, pageDecouverte(avancementDecouverte(d), d.id));
    }
    if (m === 'GET' && p === '/decouverte.json') {
      if (trop(REGLES.api)) return json(res, { erreur: 'trop de requêtes' }, 429);
      const d = lireDecouverte(url.searchParams.get('id') ?? '');
      // 🔴 On vérifie que la déclaration appartient à CE compte. Sans ça,
      //    n'importe quel membre connecté sonderait celle d'un autre — et
      //    apprendrait son portefeuille au moment où il est trouvé.
      if (!d || d.compte_id !== compte.id) return json(res, { erreur: 'déclaration inconnue' }, 404);
      const frais = await rafraichirDecouverte(d);
      if (frais.etat === 'trouve' && frais.wallet && !estVerifie(compte.id)) {
        // ⭐ `lier()` est le geste COMMUN aux deux parcours : c'est lui qui
        //    refuse un portefeuille déjà pris par un autre compte. On ne le
        //    réécrit pas ici.
        const r = lier(compte.id, frais.wallet);
        /**
         * 🔴 UN ÉTAT À LUI, PAS UN ÉTAT RECYCLÉ. La première version renvoyait
         *    'deux_portefeuilles' — la personne lisait « vos deux objets
         *    viennent de deux portefeuilles différents », ce qui est FAUX : ils
         *    venaient du même, c'est le compte qui est pris. Elle repartait
         *    refaire un geste qui ne pouvait pas mieux marcher.
         * ⭐ Et le message vient de `lier()`, qui sait QUI le détient et rend
         *    un indice d'adresse masqué : le refus devient une porte.
         */
        if (!r.ok) return json(res, { ...avancementDecouverte(frais), etat: 'deja_lie', message: r.message });
        try { await synchroniser(compte.id, frais.wallet); } catch { /* on réessaiera */ }
      }
      return json(res, avancementDecouverte(frais));
    }
    /**
     * ⭐ L'AIDE À LA SAISIE — et elle n'est QUE cela.
     * ⛔ Cette liste ne refuse rien : elle propose. La vérité est la chaîne.
     * ⚠️ Sans session, pas de liste : ce n'est pas une donnée secrète, mais
     *    ce n'est pas non plus un service public à servir à tout venant.
     */
    if (m === 'GET' && p === '/catalogue.json') {
      if (trop(REGLES.api)) return json(res, [], 429);
      return json(res, await nomsCollectibles());
    }

    if (m === 'GET' && p === '/apres') {
      /**
       * ⛔ ON NE TOUCHE PAS AU CONTRAT DES JEUX DANS CE LOT. `verifier()`
       *    (jetons.ts) exige `compte` ET `wallet` dans la charge : émettre
       *    un jeton sans portefeuille produirait un « charge incomplète »
       *    côté jeu, c'est-à-dire une porte fermée sans explication.
       *
       *    Un membre sans portefeuille qui arrive par un jeu doit donc
       *    d'abord en vérifier un — et c'est cohérent : un jeu qui fait
       *    combattre des collectibles a besoin de savoir lesquels sont à
       *    lui. Le jour où veveprice voudra faire entrer un membre SANS
       *    portefeuille, ce sera une décision sur la forme du jeton, pas
       *    un assouplissement glissé ici.
       */
      if (!compte.verifie) return vers(res, compte.wallet ? '/choisir' : '/compte');
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
      /**
       * 🔴🔴 C'ÉTAIT ICI LE MUR, ET C'EST ICI QU'IL TOMBE (lot 89).
       *
       * L'ancienne ligne était `if (!compte.verifie) return vers('/choisir')`.
       * Pour un membre inscrit par courriel, elle envoyait vers une page
       * qui demande un portefeuille qu'il n'a pas — et `/choisir` renvoie
       * maintenant vers `/compte` : une BOUCLE de redirections, sur la
       * première page que voit un nouvel inscrit.
       *
       * ⭐ La règle décidée : « une invitation, jamais un mur ». Un compte
       *    sans portefeuille voit son compte, et la proposition de le
       *    vérifier. Un compte QUI A un portefeuille non encore prouvé est
       *    au milieu du parcours : lui, on le ramène où il en était.
       */
      if (!compte.verifie && compte.wallet) return vers(res, '/choisir');
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
    if (m === 'POST' && p === '/supprimer') {
      const bilan = demanderSuppression(compte.id);
      /**
       * ⭐ On ferme AUSSI les sessions ouvertes sur les sites. Sans ça, la
       *    personne « supprime son compte » et reste connectée sur
       *    veveprice — `etatDeLaSession()` refuse déjà un compte marqué
       *    supprimé, mais fermer explicitement vaut mieux que compter sur
       *    un contrôle situé ailleurs.
       */
      if (bilan.ok) revoquerTout(compte.id);
      return vers(res, '/compte?msg=' + encodeURIComponent(bilan.message));
    }
    if (m === 'POST' && p === '/annuler-suppression')
      return vers(res, '/compte?msg=' + encodeURIComponent(annulerSuppression(compte.id).message));

    return vers(res, '/compte');
  } catch (e) {
    console.error('[identité]', e);
    return html(res, accueil(undefined, 'Quelque chose a cassé de notre côté.'), 500);
  }
});

export function demarrer(port = PORT): void {
  // ⭐ AVANT d'ouvrir le port. Si l'installation est fautive, on veut que ce
  // soit la PREMIÈRE chose lisible dans le journal, pas une ligne noyée
  // après « à l'écoute ».
  annoncerDemarrage();
  /**
   * 🔴🔴🔴 LOT 108 — ON OUVRE LA BASE **AVANT** LE PORT.
   *
   * CE QUE LA PARESSE A COÛTÉ, LE 07/08, À LA MINUTE PRÈS :
   *   14:42  le lot 107 est déposé
   *   14:44  le conteneur démarre, `/sante` répond, Coolify dit « healthy »
   *   14:45  on cherche la preuve de la migration : elle n'y est pas
   *   15:02  **première requête qui touche la base** — la migration tourne
   * Pendant DIX-HUIT MINUTES, le service était en ligne, vert de partout, et
   * `comptes` n'avait toujours pas sa colonne `site`. Et la conclusion tirée
   * à 14:45 — « migration NON PROUVÉE » — était fausse pour la seule raison
   * qu'elle était PRÉMATURÉE.
   *
   * ⭐⭐⭐ UNE MESURE PAS ENCORE MÛRE ET UNE MESURE PÉRIMÉE SE RESSEMBLENT
   *    EXACTEMENT, ET ELLES SONT L'INVERSE L'UNE DE L'AUTRE. La seule
   *    défense est de supprimer l'écart : ce qui doit être vrai au
   *    démarrage se fait AU démarrage.
   *
   * Trois effets, et le troisième est le plus important :
   *   ① le journal de migration sort juste sous le cadre de contrôle —
   *     c'est-à-dire là où on le cherche ;
   *   ② la fenêtre où la base a l'ancienne forme n'existe plus ;
   *   ③ une migration qui échoue **empêche le port de s'ouvrir**, donc fait
   *     ÉCHOUER le déploiement — au lieu de le laisser réussir sur une base
   *     à l'ancienne forme. C'est aussi ce qui rend bruyant un volume monté
   *     en lecture seule, puisque `base()` y écrit maintenant (voir db.ts).
   *
   * ⛔ NE PAS l'envelopper dans un `try`. Le repli tentant — « on démarre
   *    quand même, on verra bien » — est exactement le repli qui a produit
   *    la journée du 07/08.
   */
  base();
  serveur.listen(port, () => {
    console.log(`[identité] à l'écoute sur ${port}`);
    const j = [...jeux().keys()];
    console.log(`[identité] jeux déclarés : ${j.length ? j.join(', ') : 'AUCUN — variable JEUX vide'}`);
    // (clés et ID_SERVICE : dits par annoncerDemarrage() ci-dessus)
    const menage = setInterval(() => {
      purgerSeaux(); purgerDefis(); purgerDecouvertes(); purgerLiens(); purgerSessions(); purgerRelais();
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
