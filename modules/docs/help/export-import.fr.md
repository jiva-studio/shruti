Vos **données personnelles** résident dans une base de données locale sur
l'appareil. Elles ne sont jamais envoyées à un serveur. Pour les
transférer d'un appareil à un autre ou en conserver une sauvegarde,
l'application prend en charge l'export et l'import.

## Ce que contient la sauvegarde

Un fichier de sauvegarde inclut tout ce qui est personnel :

- Votre playlist et l'ordre des pistes qui s'y trouvent.
- La progression d'écoute de chaque piste et celles que vous avez
  terminées.
- Les notes et les signets.
- Les enregistrements des pistes téléchargées.
- Les filtres de recherche enregistrés.

Une sauvegarde n'inclut **pas** le catalogue de conférences lui-même —
celui-ci provient du serveur de contenu. Après l'import sur un nouvel
appareil, l'application récupérera le catalogue automatiquement.

## Export

1. Ouvrez **Paramètres → Données → Exporter les données utilisateur**.
2. Sur un téléphone, la feuille de partage du système s'ouvre — choisissez
   où enregistrer (cloud, e-mail, Fichiers, etc.). Sur le web, le
   navigateur lance un téléchargement.
3. Le fichier est une base de données SQLite ordinaire.

Vous pouvez exporter aussi souvent que vous le souhaitez — l'export ne
modifie rien dans l'application.

## Import

1. Ouvrez **Paramètres → Données → Importer les données utilisateur**.
2. Choisissez un fichier `.db` exporté précédemment.
3. Confirmez la boîte de dialogue de remplacement. L'application arrête le
   lecteur, remplace chaque table utilisateur par ce qui se trouve dans le
   fichier, puis se recharge.

> **À noter.** L'import **remplace** les données existantes — la playlist,
> les notes, les téléchargements et la progression actuellement dans
> l'application seront écrasés. Il n'y a pas d'annulation possible.
> Exportez d'abord l'état actuel si vous voulez le conserver.

## Vider le cache vs. effacer les données utilisateur

Dans la **Zone sensible** (visible uniquement après avoir déverrouillé la
section de débogage), vous trouverez deux options destructrices faciles à
confondre :

- **Vider le cache** supprime tout l'audio et toutes les transcriptions
  téléchargés. Cela ne touche ni à votre playlist, ni à vos notes, ni à
  votre progression d'écoute.
- **Effacer les données utilisateur** efface chaque table personnelle —
  même effet qu'une installation neuve. Le catalogue de conférences reste.

Exportez toujours avant d'effacer les données utilisateur.
