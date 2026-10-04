// Titles and explanations of the three takeover dialogs, without the dialog code.
// i18n
export const TAKEOVER = {
  push: {
    title: 'Auf Server übertragen',
    subtitle: 'Die Sammlung dieses Geräts auf einen neuen Server bringen (inklusive Cover)',
    intro: 'Für einen frisch eingerichteten Server: Melde dich mit dem Administrator-Konto an. Die App packt ihre Sammlung als Backup und spielt sie dort ein; dein lokales Profil wird zu diesem Konto.'
  },
  merge: {
    title: 'Zusammenführen',
    subtitle: 'Die Sammlung dieses Geräts in einen Server mit Daten übernehmen',
    intro: 'Reihen und Bände kommen per CSV dazu (erst ein Probelauf mit Vorschau). Besitz und Lesestatus landen beim angemeldeten Benutzer; vorhandene Einträge bleiben unverändert. Cover werden nicht übertragen – das Autofill kann sie nachladen.'
  },
  pull: {
    title: 'Vom Server holen',
    subtitle: 'Die Sammlung eines Servers auf dieses Gerät übernehmen',
    intro: 'Als Administrator holt die App das komplette Backup mit Covern; als anderer Benutzer die Offline-Kopie (Reihen, Bände, dein Besitz und Lesestatus; Cover werden nachgeladen). Die Sammlung auf diesem Gerät wird dabei ersetzt.'
  }
};
