# Node 22 exécute le TypeScript nativement : aucune étape de build, aucune
# dépendance à installer. C'est le principe fondateur du projet — chaque
# dépendance évitée est une panne de déploiement évitée.
FROM node:22-alpine

# ⭐ GARDE-FOU DE VERSION, AU BUILD.
# L'exécution directe d'un fichier .ts sans drapeau n'existe QU'À PARTIR DE
# NODE 22.18 (« type stripping » activé par défaut). En dessous, le serveur
# ne démarrerait pas et l'erreur parlerait de syntaxe TypeScript — un
# message parfaitement incompréhensible pour qui n'a pas ce contexte.
# `node:22-alpine` est une étiquette MOUVANTE : on ne suppose pas, on vérifie,
# et on échoue ici — dans le journal de build, avec une phrase claire —
# plutôt qu'au démarrage en production.
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); \
  if (a<22 || (a===22 && b<18)) { \
    console.error('\n🔴 Node '+process.versions.node+' est TROP ANCIEN.\n'+ \
      'Ce projet exécute du TypeScript sans étape de build, ce qui exige Node 22.18 ou plus.\n'+ \
      'Corrigez la première ligne du Dockerfile (FROM node:22-alpine).\n'); \
    process.exit(1); \
  } \
  console.log('✅ Node '+process.versions.node+' — exécution TypeScript native disponible');"

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server.ts ./

# ⭐ ÉPREUVE DE FUMÉE AU BUILD : on charge tout le graphe de modules sans
# démarrer le serveur. Une faute de frappe, un import cassé, un fichier
# oublié à l'upload — les pannes de déploiement les plus probables — sont
# ainsi attrapées ICI, dans le journal de build, au lieu de produire un
# conteneur qui redémarre en boucle sans qu'on sache pourquoi.
# (On ne lance pas la suite de tests complète : un test sensible à
# l'environnement bloquerait tout déploiement, ce qui serait pire.)
RUN node -e "await import('./src/db.ts'); \
  await import('./src/demarrage.ts'); \
  await import('./src/avoirs.ts'); \
  await import('./src/defi.ts'); \
  await import('./src/jetons.ts'); \
  await import('./src/jeux.ts'); \
  await import('./src/vues.ts'); \
  await import('./server.ts'); \
  console.log('✅ tous les modules se chargent');" --input-type=module

# 🔴 PAS DE `VOLUME ["/data"]` ICI — C'EST VOLONTAIRE.
#
# Cette instruction paraît utile, elle est en réalité DANGEREUSE avec Coolify.
# Si personne n'a monté de stockage persistant, Docker fabrique tout seul un
# volume ANONYME : le jeu tourne, les données semblent tenir… et le prochain
# conteneur en reçoit un NOUVEAU, vide. La perte est totale et silencieuse.
#
# Sans cette ligne, un `/data` non monté reste un simple dossier de l'image —
# ce que le contrôle de démarrage (src/demarrage.ts) SAIT détecter et
# annonce en toutes lettres dans le journal. On préfère une panne qui se voit
# à une panne qui se cache.
RUN mkdir -p /data

ENV NODE_ENV=production PORT=3000 DB_PATH=/data/veve-id.db
EXPOSE 3000

# Le serveur est mono-fil : si /sante ne répond pas, il est vraiment bloqué.
# ⭐ On interroge avec Node lui-même plutôt qu'avec `wget` : c'est une
# supposition de moins sur le contenu de l'image, et c'est cohérent avec le
# principe du projet — ne dépendre de rien qu'on n'ait pas éprouvé.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/sante') \
    .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# ⚠️ Pas d'ENTRYPOINT tini ici. On lit souvent qu'un processus PID 1 doit
# être encadré par un init pour recevoir SIGTERM — c'est vrai des processus
# qui ne DÉCLARENT AUCUN gestionnaire. Le nôtre en déclare un explicitement
# (voir la fin de server.ts), il reçoit donc le signal normalement.
# Ajouter une dépendance à un binaire dont on n'est pas certain qu'il soit
# dans l'image ferait courir un risque bien plus grand — un conteneur qui ne
# démarre pas du tout — pour un bénéfice nul.
CMD ["node", "server.ts"]
