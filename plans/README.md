# Umsetzungspläne

Stand: 15. September 2026, Ausgangsbasis Commit `521e544`.
Die verschachtelten Gruppen sind implementiert und vollständig geprüft.
Der Produktionsrollout wird als anschließende Veröffentlichung im PR verfolgt;
er ist in diesem Commitstand noch ausstehend.

| Plan | Ziel | Priorität | Aufwand | Abhängigkeit | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-projects-and-grouping.md) | Frei verschachtelbare Gruppen für Dateien, einschließlich Browser und CLI | P1 | L; ursprüngliche Schätzung 8–13 Tage | Keine | DONE — Implementierung und Abnahme abgeschlossen |

Vorhanden: Datenmodell und additive Migration, Baumoperationen und API,
Dashboardnavigation und Uploadziele, CLI und Dokumentation. Die gesamte erste
Version unterstützt mehrere Ebenen. Der Nutzer hat die anschließende Veröffentlichung
in Produktion ausdrücklich beauftragt; sie folgt nach erfolgreicher Abnahme.

Der Nutzer wünscht ausdrücklich eine möglichst flexible, mehrstufige Struktur.
Der frühere Vorschlag mit einer flachen Projektebene und dessen Aufwandsschätzung
wurden vollständig ersetzt. Der Dateiname bleibt für bestehende Links erhalten.

Später vorgesehen: Verknüpfungen zu Dateien in mehreren Gruppen, Tags, Favoriten,
Archiv und gesondert geplante Team-/Gruppenfreigaben. Verschachtelung ist bereits
Teil dieses Plans, keine aufgeschobene Erweiterung.

Statuswerte: TODO, IN PROGRESS, DONE, BLOCKED mit Grund, REJECTED mit Begründung.
DONE erst nach den Abnahmekriterien setzen.

Prüfstand: Frische isolierte Datenbankmigrationen, Upgrade mit vorhandenen
öffentlichen/privaten/passwortgeschützten Drafts und Versionen sowie
`npm run check:quick` bestanden. Der finale `npm run check:full` bestand mit
440 Unit-/Sicherheits-/Datenbanktests und 37/37 Browser-/CLI-Journeys; ein optionaler
Live-Provider-Test wurde übersprungen. CLI- und Produktionsbuild sowie Uploadartefakt-
Prüfungen bestanden ebenfalls. Tiefe Zielauswahl, Viewer und Upload-/Kontolöschlebenszyklus
sind geprüft. Zusätzlich bestanden 3/3 Viewerregressionen für öffentliche,
private und passwortgeschützte Inhalte vor und nach Baumänderungen.
CLI 0.3.0 ist vorbereitet; Tarball-Installation und Hilfeausgabe bestanden.
Die npm-Veröffentlichung wartet auf die Anmeldung des Nutzers (401).
Produktionsrollout und npm-Veröffentlichung sind getrennte Veröffentlichungsschritte
und in diesem Commitstand noch nicht abgeschlossen. Lokale Tests belegen keine
Provider-CORS- oder Produktionsstreaming-Eigenschaften.
