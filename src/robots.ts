import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * ⭐⭐ LES GARDE-FOUS CONTRE LES ROBOTS — et ce qu'ils protègent VRAIMENT.
 *
 * 🔴 LE DANGER N'EST PAS « DES ROBOTS CRÉENT DES COMPTES ». Un compte né d'un
 *    lien jamais cliqué n'existe pas : la table `comptes` ne reçoit une ligne
 *    qu'à la CONSOMMATION du lien. Un robot qui poste mille adresses ne crée
 *    donc aucun compte.
 *
 *    Les deux vrais dangers sont ailleurs, et ils coûtent cher :
 *
 *  ① **LE QUOTA D'ENVOI.** Le palier gratuit de Brevo est de 300 courriels par
 *     jour. Un robot le brûle en quelques minutes, et plus personne ne peut
 *     s'inscrire jusqu'au lendemain — sans le moindre message d'erreur, la
 *     page dira toujours « vérifiez vos e-mails ».
 *
 *  ② **LE BOMBARDEMENT D'UN TIERS.** Quelqu'un fait envoyer cent liens à une
 *     adresse qui n'est pas la sienne. La victime signale « courrier
 *     indésirable », et c'est NOTRE domaine d'envoi qui perd sa réputation.
 *     ⭐⭐⭐ Ce défaut-là ne nous coûte pas une panne : il coûte la capacité
 *     d'envoyer, pour tout le monde, durablement.
 *
 * ⛔ PAS DE CAPTCHA, ET C'EST UN CHOIX. Il ajoute une dépendance externe, du
 *    JavaScript tiers, un traceur, et une friction sur l'écran le plus fragile
 *    du parcours. Les deux contrôles ci-dessous coûtent zéro friction à un
 *    humain et arrêtent l'écrasante majorité des robots — ceux qui postent un
 *    formulaire sans le rendre. Le jour où un adversaire déterminé passera, le
 *    limiteur par adresse tiendra encore, et ALORS un captcha se discutera.
 */

/**
 * ① LE CHAMP PIÈGE.
 *
 * Un champ que le navigateur cache et qu'aucun humain ne voit. Un robot qui
 * remplit « tous les champs » le remplit aussi — et se désigne.
 *
 * ⚠️ LE NOM COMPTE. `piege` ou `honeypot` serait ignoré par tout robot un peu
 *    sérieux. On prend un nom que les formulaires portent vraiment, et qu'un
 *    robot a INTÉRÊT à remplir.
 * ⛔ ET IL NE SE CACHE PAS AVEC `type="hidden"` : un champ caché n'est pas
 *    censé être rempli par l'utilisateur, les robots le savent et le laissent.
 *    Il faut un champ VISIBLE pour le code, invisible à l'écran.
 * ⚠️ `aria-hidden` + `tabindex="-1"` + `autocomplete="off"` : sans ça, un
 *    lecteur d'écran l'annonce et un gestionnaire de mots de passe le remplit
 *    — on bloquerait de vraies personnes, silencieusement.
 */
export const CHAMP_PIEGE = 'site_web';

/**
 * ② LE DÉLAI MINIMUM.
 *
 * Un humain met plusieurs secondes à lire, cliquer, taper. Un robot poste dans
 * la seconde. On scelle donc l'heure d'affichage du formulaire et on refuse ce
 * qui revient trop vite.
 *
 * 🔴 LE SCEAU EST SIGNÉ. Sans signature, il suffirait de poster un horodatage
 *    vieux de dix secondes : le contrôle ne coûterait rien à contourner et
 *    donnerait l'illusion d'une protection.
 * ⚠️ ET IL EXPIRE. Un sceau valable indéfiniment se récolte une fois et se
 *    rejoue mille fois — ce serait un laissez-passer, pas un délai.
 */
export const DELAI_MIN_MS = 2500;
export const DELAI_MAX_MS = 2 * 3600_000;   // deux heures : un onglet oublié

let _secret: string | null = null;
/** ⚠️ Lecture paresseuse : lu à l'import, le secret arriverait avant sa pose. */
function secret(): string {
  if (_secret) return _secret;
  _secret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
  return _secret;
}

const signer = (v: string) => createHmac('sha256', secret() + '|robots').update(v).digest('base64url');

export function sceau(maintenant = Date.now()): string {
  const corps = String(maintenant);
  return `${corps}.${signer(corps)}`;
}

export interface Verdict { ok: boolean; pourquoi?: string }

/**
 * 🔴 CE QUE CETTE FONCTION NE FAIT PAS : décider quoi RÉPONDRE.
 *
 * Un robot démasqué ne doit pas recevoir un message qui lui apprend ce qui l'a
 * trahi — sinon on lui offre le moyen de corriger. C'est l'appelant qui rend
 * la MÊME page que pour un succès, et journalise. Ici on se contente de dire
 * ce qu'on a vu, et à qui de droit.
 */
export function verdict(
  champPiege: string | null | undefined,
  sceauFourni: string | null | undefined,
  maintenant = Date.now(),
): Verdict {
  if (champPiege && String(champPiege).trim() !== '')
    return { ok: false, pourquoi: 'champ piège rempli' };

  const s = String(sceauFourni ?? '');
  if (!s.includes('.')) return { ok: false, pourquoi: 'sceau absent' };
  const i = s.lastIndexOf('.');
  const corps = s.slice(0, i);
  const sig = s.slice(i + 1);
  const attendu = signer(corps);
  if (sig.length !== attendu.length) return { ok: false, pourquoi: 'sceau invalide' };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return { ok: false, pourquoi: 'sceau invalide' };

  const ts = Number(corps);
  if (!Number.isFinite(ts)) return { ok: false, pourquoi: 'sceau illisible' };
  const age = maintenant - ts;
  if (age < DELAI_MIN_MS) return { ok: false, pourquoi: `formulaire posté en ${age} ms` };
  if (age > DELAI_MAX_MS) return { ok: false, pourquoi: 'sceau périmé' };
  return { ok: true };
}

/**
 * ⭐⭐ L'ADRESSE RÉELLE DU VISITEUR, QUAND UN RELAIS AUTHENTIFIÉ LA TRANSMET.
 *
 * 🔴 LE DÉFAUT QUE CECI CORRIGE, ET IL ÉTAIT GRAVE DANS L'AUTRE SENS.
 *    `REGLES.verifier` limite à 5 tentatives par 10 minutes, sur la clé
 *    `adresse|chemin`. Derrière le relais de veveprice, `adresse()` rend
 *    l'adresse de VEVEPRICE — la même pour tout le monde.
 *    ⇒ **5 inscriptions par 10 minutes pour la Terre entière.**
 *    Ce n'était pas une protection contre les robots : c'était une panne à
 *    partir du sixième inscrit, et un robot seul suffisait à fermer la porte
 *    à tous les autres.
 *
 * ⭐ POURQUOI ON PEUT CROIRE CET EN-TÊTE ICI, alors que `limite.ts` refuse de
 *    croire `X-Forwarded-For` sans `TRUST_PROXY`. La différence est
 *    l'AUTHENTIFICATION : cet en-tête n'est lu que sur une requête qui a déjà
 *    présenté `x-service`, le secret partagé. Ce n'est pas « un en-tête qu'on
 *    croit », c'est « une information transmise par un service identifié ».
 * ⛔ NE JAMAIS lire cet en-tête sur une route publique.
 */
export function adresseRelayee(brut: unknown): string | null {
  const v = typeof brut === 'string' ? brut.split(',')[0].trim() : '';
  if (!v || v.length > 45) return null;
  // On ne valide pas la FORME d'une adresse IP (v4, v6, mappée…) : on veut
  // seulement une clé de seau stable et non absurde.
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}
