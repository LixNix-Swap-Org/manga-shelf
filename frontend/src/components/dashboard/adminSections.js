import { BrushCleaning, CloudUpload, Download, FileSpreadsheet, GitMerge, Library, Server, Settings, Trash2, Users } from 'lucide-react';
import { t } from '../../i18n/index.js';

/**
 * "Verwaltung": every entry the header used to show side by side (account, people and shelves, data tools, system),
 * grouped in four sections. Each entry opens the same dialog as before and is shown to the same roles as before;
 * an entry without an action (`run` null) is left out.
 */
export function adminSections({
  local = false, offline = false, isAdmin = false, canEdit = false, toolsAvailable = true,
  onAccount, onUsers, onShelves, onBackups, onCsv, onCleanup, onTrash, onPublishers, onSystem, onInstall
}) {
  const sections = [
    {
      id: 'account',
      title: t('Konto'),
      entries: [
        !offline && { id: 'btn-admin-account', Icon: Settings, label: t('Konto & Sprache'), hint: local ? t('API-Schlüssel, Sprache und Privatsphäre') : t('Passwort, API-Schlüssel, Sprache und Privatsphäre'), run: onAccount },
        onInstall && { id: 'btn-admin-install', Icon: Download, label: t('App installieren'), hint: t('MangaShelf als App installieren'), run: onInstall }
      ]
    },
    {
      id: 'people',
      title: t('Personen & Regale'),
      entries: [
        isAdmin && !local && { id: 'btn-admin-users', Icon: Users, label: t('Benutzer'), hint: t('Benutzer anlegen und verwalten'), run: onUsers },
        toolsAvailable && !local && { id: 'btn-admin-shelves', Icon: Library, label: t('Regale'), hint: t('Regale verwalten & freigeben'), run: onShelves }
      ]
    },
    {
      id: 'data',
      title: t('Daten'),
      entries: [
        isAdmin && { id: 'btn-admin-backups', Icon: CloudUpload, label: t('Backups'), hint: local ? t('Sicherung als ZIP exportieren oder importieren') : t('Backup-Zentrale, automatische Snapshots, ZIP-Download & Wiederherstellung'), run: onBackups },
        onCsv && { id: 'btn-admin-csv', Icon: FileSpreadsheet, label: 'CSV', hint: canEdit ? t('Sammlung als CSV exportieren oder aus CSV importieren') : t('Sammlung als CSV exportieren'), run: onCsv },
        toolsAvailable && { id: 'btn-admin-cleanup', Icon: BrushCleaning, label: t('Sammlung aufräumen'), hint: t('Dubletten & Qualität prüfen'), run: onCleanup },
        toolsAvailable && { id: 'btn-admin-trash', Icon: Trash2, label: t('Papierkorb'), hint: t('Gelöschte Bände wiederherstellen'), run: onTrash },
        toolsAvailable && isAdmin && { id: 'btn-admin-publishers', Icon: GitMerge, label: t('Verlage zusammenführen'), hint: t('Verlags-Aliase vereinheitlichen'), run: onPublishers }
      ]
    },
    {
      id: 'system',
      title: t('System'),
      entries: [
        isAdmin && !local && !offline && { id: 'btn-admin-system', Icon: Server, label: t('System'), hint: t('System: Version, Speicher, Backups, Quellen'), run: onSystem }
      ]
    }
  ];
  return sections
    .map((section) => ({ ...section, entries: section.entries.filter((entry) => entry && typeof entry.run === 'function') }))
    .filter((section) => section.entries.length > 0);
}
