# Plan 001: Dateien in frei verschachtelbaren Gruppen organisieren

Stand: 15. September 2026, Ausgangsbasis Commit `521e544`.
Status: **DONE — Implementierung und Abnahme abgeschlossen**.
Produktionsrollout: anschließender Veröffentlichungsschritt, in diesem Commitstand
noch ausstehend und im PR verfolgt.
Priorität P1 · Aufwand L · technisches Risiko mittel · Kategorie Produktentwicklung.
Keine Abhängigkeit von anderen Plänen.

## Ziel und bestätigte Richtung

Der Nutzer möchte die Organisation **so flexibel wie möglich, ausdrücklich auch
mehrstufig**. Deshalb erhält AgentPlan frei benennbare **Gruppen mit Untergruppen**.
Eine Gruppe kann ein Kunde, ein Projekt, ein Thema, ein Jahr oder eine Arbeitsphase
sein. Alle Ebenen verwenden denselben Gruppentyp; es gibt keine vorgeschriebene
Hierarchie wie Kunde → Projekt → Phase. Die folgende Struktur ist ein Beispiel:

```text
AgentPlan
├── Alle Dateien
├── Ohne Gruppe
└── Gruppen
    ├── Kunden
    │   └── Beispiel GmbH
    │       ├── Website-Relaunch
    │       │   ├── Briefing.html
    │       │   ├── Recherche
    │       │   │   └── Wettbewerbsanalyse.html
    │       │   └── Design
    │       │       ├── Entwurf.webp
    │       │       └── Demo.mp4
    │       └── Präsentationen
    └── Eigene Ideen
        ├── App-Konzept.html
        └── Experimente
```

Jede Gruppe darf gleichzeitig Dateien und Untergruppen enthalten. Tiefe und Namen
richten sich nach dem Bedarf; es gibt keine Produktbeschränkung auf zwei oder drei
Ebenen. Eine kurze Beschreibung erklärt bei Bedarf, was dazugehört.

Eine Datei hat zunächst einen Ablageort. Das ist eine Empfehlung für verständliches
Verschieben, keine ausdrückliche Nutzeranforderung. Verknüpfungen zu derselben Datei
in weiteren Gruppen sind die nächste optionale Ausbaustufe; sie sollen dieselbe
Veröffentlichung referenzieren und keine Dateikopien erzeugen. Die erste Umsetzung
umfasst bereits die vollständige Verschachtelung, nicht nur eine flache Vorstufe.

Der bestehende Dateiname dieses Plans bleibt für bereits geteilte Links erhalten.
Die implementierten Entitäten heißen `groups`, nicht `projects`.

## Bedienung der ersten Version

| Bereich | Verhalten |
| --- | --- |
| Navigation | Desktop: aufklappbare Gruppen neben „Alle Dateien“ und „Ohne Gruppe“. Untergruppen bedarfsgerecht nachladen. Mobil: Gruppenübersicht und Pfadnavigation statt immer tiefer eingerückter Seitenleiste. |
| Gruppenübersicht | Zeigt oberste Gruppen, Beschreibungen, direkte Untergruppenanzahl und Dateianzahl einschließlich Untergruppen. Neue Hauptgruppe anlegen. |
| Gruppenseite | Oben Pfad, Name und Beschreibung. Darunter direkte Untergruppen und direkt abgelegte Dateien in getrennten Bereichen. |
| Ansichtswechsel | „Untergruppen einbeziehen“ zeigt alle Dateien des Teilbaums in einer flachen Liste mit ihrem jeweiligen Ablagepfad. Direkte Untergruppen bleiben separat navigierbar. |
| Anlegen | „Neue Gruppe“ und „Neue Untergruppe“. Name erforderlich, Beschreibung optional; leere Gruppen sind erlaubt. |
| Upload | Die aktuell geöffnete Gruppe ist vorausgewählt, auch in der Ansicht mit Untergruppen. Sonst „Ohne Gruppe“. Ziel vor dem Upload änderbar. |
| Dateien einsortieren | Einzel- und Mehrfachauswahl mit „Verschieben nach …“. Zielauswahl kann den Baum durchsuchen, aufklappen und eine neue Untergruppe anlegen. |
| Gruppen umorganisieren | Ganze Gruppe samt Untergruppen und Dateien an eine andere Stelle verschieben oder zur Hauptgruppe machen. Ziel darf nicht die Gruppe selbst oder einer ihrer Nachfahren sein. |
| Mehrfachauswahl | Nur Dateien der sichtbaren Seite, maximal 50. Anzahl deutlich anzeigen. Seiten-/Filterwechsel leert die Auswahl. In der ersten Version keine gemischte Auswahl von Gruppen und Dateien. |
| Suche | Suche aus einer Gruppenseite umfasst standardmäßig deren Untergruppen. „Nur diese Gruppe“ schränkt sie ein. „Überall suchen“ öffnet die globale Dateisuche mit demselben Suchtext. |
| Detailseite | Vollständigen Ablagepfad anzeigen, zur Gruppe zurückgehen und Zuordnung ändern. |
| Gruppe auflösen | Nur den gewählten Gruppenbehälter entfernen. Direkte Dateien und direkte Untergruppen eine Ebene höher verschieben; deren Inhalte bleiben zusammen. Beim Auflösen einer Hauptgruppe werden deren direkte Dateien unzugeordnet und deren direkte Untergruppen zu Hauptgruppen. |

Ohne Suchtext zeigt eine Gruppe standardmäßig nur ihre direkten Dateien. Bei einer
neu gestarteten Suche wird „Untergruppen einbeziehen“ eingeschaltet; die ausdrückliche
Nutzerauswahl danach bleibt über Pagination erhalten. Ansicht und Suche stehen in
URL-Parametern und sind mit Zurück/Vorwärts reproduzierbar.

Die Dateianzahl einer Gruppenkarte ist als „Dateien insgesamt“ beschriftet. Im
Gruppeninhalt steht getrennt „Dateien hier“. Damit bedeuten etwa 30 auf der Karte
und drei direkte Dateien auf der Gruppenseite keinen widersprüchlichen Zähler.
Untergruppen- und Dateilisten haben getrennte Paginationparameter.

Die englische Produktsprache bleibt konsistent: „Groups“, „All files“, „Ungrouped“,
„New subgroup“, „Move to …“, „Include subgroups“, „Dissolve group“. Bestehende
Farben, Schriftarten und Fokusrahmen verwenden. Alle Aktionen funktionieren mit
Tastatur und Touch; Drag-and-drop kann später dieselben Aktionen ergänzen.
Lange Pfade mittig verkürzen und vollständig zugänglich machen. Zielauswahl zeigt
vollständige Pfade; gleiche Namen sind erlaubt, intern werden immer IDs verwendet.
Bei identischen Pfaden ein zusätzliches ID-Kürzel zur Unterscheidung anzeigen.

## Zugehörigkeit, Freigaben und Lebenszyklus

1. Ein Draft hat null oder eine `groupId`. Versionen und Bundle-Assets gehören
   weiterhin zum Draft. Eine HTML-Datei mit eingebetteten Medien ist ein Bundle,
   keine Untergruppe; Gruppen erzeugen keine neue Datei und keine neue Version.
2. Alle Gruppen eines Baums gehören demselben Konto. Gruppenmitgliedschaft und
   Hierarchie verändern keine Sichtbarkeit, Passwörter oder Ablaufdaten. Öffentliche
   Viewer verraten weder Gruppennamen noch Geschwister oder Vorfahren.
3. Dateien verschieben ändert nur ihre Zuordnung und bei tatsächlicher Änderung
   `drafts.updatedAt`. Links, Versionen, Quoten und Storage-Keys bleiben erhalten.
4. Eine Gruppe verschieben ändert ihre `parentId`, nicht die `groupId` ihrer Dateien.
   Keine Kopie des Teilbaums und keine Aktualisierung sämtlicher Datei-Zeitstempel.
   Umbenennen verändert keine Identitäten. Pfade werden aus der Hierarchie abgeleitet.
5. Neue Versionen und Restores behalten die aktuelle Zuordnung des Drafts. Ein
   laufender Versionsupload darf eine inzwischen erfolgte Verschiebung nicht aufheben.
6. Auflösen einer Gruppe leitet direkte Drafts und gespeicherte Ziele neuer Uploads
   zum bisherigen Elternknoten um; bei einer Hauptgruppe ist das Ziel null.
   Direkte Untergruppen werden ebenfalls zum bisherigen Elternknoten umgehängt.
   Unterhalb dieser Kinder bleibt die Struktur bestehen. Es gibt kein rekursives
   Löschen von Dateien als Gruppenaktion.
7. Uploads mit bereits gespeichertem Intent können nach dem Auflösen im übergeordneten
   Ziel abschließen. Ein neuer Upload auf eine schon aufgelöste oder fremde Gruppe
   wird abgewiesen. Legacy-Multipart besitzt keinen Intent: Zielprüfung und Erstellung
   laufen unter derselben Kontosperre wie das Auflösen. Erstellung zuerst bedeutet
   nachträgliches Umordnen; Auflösen zuerst bedeutet Ablehnung vor dem Storage-Schreiben.
8. Gelöschte, abgelaufene und moderierte Drafts fehlen in direkten und rekursiven
   Listen sowie Zählern. Leere Gruppen bleiben bestehen. Alle Ansichten prüfen den
   aktuellen Kontostatus; Baumabfragen sind keine Umgehung bestehender Berechtigungen.
9. Bestehende Daten beginnen unter „Ohne Gruppe“. Organisation ist optional und
   für alle Kontopläne vorgesehen. Kontingente gelten weiter kontoweit.

Der Dialog zum Auflösen beschreibt das konkrete Ziel und die Zahl direkter Dateien,
Untergruppen und bereits gestarteter Uploads. Er erklärt den Erhalt der Inhalte.
Es gibt keine zusätzliche Option „alles darin löschen“ in diesem Plan.

## Weitere Flexibilität, nach der ersten Version

| Erweiterung | Geplante Richtung |
| --- | --- |
| Verknüpfungen | Dieselbe Veröffentlichung in weiteren Gruppen referenzieren. Ein Ablageort plus zusätzliche Links; getrennte Aktionen „Link entfernen“ und „Datei löschen“. Rechte weiter am Draft prüfen. |
| Tags | Themen quer durch den Baum, etwa „Research“ oder „Entwurf“. |
| Favoriten | Häufig benötigte tiefe Gruppen direkt anspringen. |
| Archiv | Abgeschlossene Teilbäume aus der Hauptnavigation nehmen; Auswirkungen auf globale Suche und Uploadziele vorher festlegen. |
| Projektstartseite | Beschreibungen bei Bedarf um angeheftete Dateien, externe Links oder Notizen ergänzen. |
| Teams und Gruppenfreigaben | Eigenständiger Rechteplan mit klarer Vererbung und sofortigem Widerruf. Eine Kundengruppe allein gewährt niemandem Zugriff. |

Diese Erweiterungen sind nicht Voraussetzung für beliebig zusammengesetzte,
mehrstufige Strukturen. Mehrfachzuordnung wurde nicht ausdrücklich angefordert;
vor ihrer Umsetzung das Verhalten von Original, Verknüpfung und Löschen spezifizieren.

## Ausgangspunkt vor der Umsetzung

Die folgende historische Bestandsaufnahme basiert auf Commit `521e544`.
Die Zeilennummern beschreiben den damaligen Stand; die aktuellen Dateien stehen
im Abschnitt „Implementierter Umfang und Prüfungen“.

| Stelle | Bestehendes Verhalten und Anschluss |
| --- | --- |
| `app/dashboard/page.tsx:35` | 50 Drafts pro Seite, Suche, Sichtbarkeit, Zeitraum; flache Liste ab Zeile 173. |
| `components/dashboard/header.tsx:14` | Gemeinsamer Dashboardkopf ohne Gruppenbaum. |
| `app/dashboard/drafts/[id]/page.tsx:34` | Besitzergebundene Details mit Versionen, Vorschau und Freigaben. |
| `db/schema.ts:170` | Drafts mit Besitzer, Versionen ab Zeile 200 und Assets ab 232; keine Gruppen. |
| `db/schema.ts:254` | Persistente Upload-Intents vor Erstellung des Drafts. |
| `db/queries/drafts.ts:51` | Listenfilter und ownergebundene Pagination. |
| `lib/api/draft-cursor.ts:23` | Cursor an Besitzer und Filter gebunden. |
| `lib/drafts/service.ts:76` | Legacy-HTML-Multipart-Erstellung. |
| `lib/uploads/service.ts:77` | Direkte Uploads, Draft-Insert bei Zeile 454. Abschluss liest einen frischen `lockedIntent`. |
| `lib/uploads/bundles.ts:149` | Separater Bundleweg, Draft-Insert bei Zeile 661. |
| `components/dashboard/upload-form.tsx:68` | Browserziele für Einzeldatei und Bundle separat definiert. |
| `packages/cli/src/api.ts` | CLI-Draftantworten und separate Uploadzieltypen. |
| `packages/cli/src/upload-options.ts:14` | Neue-Draft-Optionen bei Versionsuploads zurückweisen. |
| `packages/upload-contract/index.d.ts` | Gemeinsame Datei-/Bundle-/Ablaufregeln, kein vollständiges Upload-DTO. |

Die bereits vorhandene fremde Änderung an `skills/agentplan/SKILL.md` wurde
als unabhängig behandelt und bleibt erhalten.

Bestehende Muster übernehmen:

```ts
// db/queries/drafts.ts:78 – Eigentum und Lebenszyklus in der Query.
const conditions = [eq(drafts.ownerId, ownerId), liveDraftCondition, isNull(users.blockedAt)];

// lib/uploads/service.ts:118 – gemeinsame Sperre vor Mutationen.
const intent = await getDb().transaction(async (tx) => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${input.ownerId}))`,
  );
  // Aktuelle Daten prüfen und innerhalb dieser Transaktion schreiben.
});
```

Die gekürzten Ausschnitte sind Orientierung, kein Einfügepatch. Vor Änderungen
`SECURITY.md`, `docs/agent-workflow.md` und installierte Next-Guides lesen:
`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
`01-app/01-getting-started/15-route-handlers.md`,
`01-app/03-api-reference/03-file-conventions/page.md` und
`01-app/03-api-reference/04-functions/revalidatePath.md` jeweils unter derselben Docs-Wurzel.

## Datenmodell und Baumabfragen

- Neue Tabelle `groups`: UUID `id`, `ownerId` als FK auf `users` mit `ON DELETE CASCADE`,
  nullable `parentId` als Selbstreferenz, `name` maximal 120 Zeichen, optionale
  `description` maximal 1.000 Zeichen, `createdAt`, `updatedAt`. Texte trimmen;
  Name nicht leer. `parentId = null` bedeutet Hauptgruppe.
- Selbstreferenz mit nicht aufgeschobener `ON DELETE NO ACTION`: eine normale
  Gruppenlöschung muss ihre Kinder zuerst explizit umhängen. Kein rekursives
  `CASCADE` an der Elternbeziehung. Kontolöschung löscht alle ownergebundenen Gruppen
  in einem Vorgang; Zusammenspiel der FKs in einer echten Postgresprüfung belegen.
- Nullable `drafts.groupId` und `uploadIntents.targetGroupId` mit FK auf `groups.id`
  und `ON DELETE SET NULL` als Absicherung. Der Service erledigt das tatsächliche
  Umhängen zum Elternknoten vor dem Löschen. Intentziel gilt nur für neue Drafts.
- Index auf `groups(ownerId, parentId, createdAt DESC, id DESC)`,
  `drafts(ownerId, groupId, updatedAt DESC, id DESC)` und passende FK-Indizes
  für Umhängen/Auflösen; bestehenden globalen Draftindex behalten.
- Migration additiv, alte Zuordnungen null. Generiertes SQL und Drizzle-Metadaten
  mit dem Schema einchecken. Keine Speicherobjekte oder Versionsdaten migrieren.
- Baum als Elternbeziehung speichern, nicht als veränderlichen Stringpfad.
  `db/queries/groups.ts` nutzt ownergebundene rekursive CTEs für Vorfahren,
  Nachfahren, Zähler und Zyklusprüfung. Kein Query pro Knoten; rekursive Traversierung
  mit besuchten IDs absichern. Fehlerhafte Zyklen als Fehler behandeln, nicht
  still abgeschnittene Teilbäume als vollständiges Ergebnis liefern.
- Hierarchie flexibel tief; keine unbemerkte Tiefenbegrenzung. Serverlaufzeit und
  Ausgabemenge bleiben begrenzt. Kinder paginieren, Navigation lazy laden und tiefe
  Pfade bei Bedarf gezielt laden. Mindestens zwölf Ebenen in Tests abdecken.
- Kinderlisten: 50 standardmäßig, maximal 200, Reihenfolge `(createdAt DESC, id DESC)`.
  Cursor bindet Besitzer, Eltern-ID, Suchmodus und Suchtext. Mikrosekundenpräzision
  wie beim bestehenden Draftcursor erhalten.
- Gruppen-Suche unterstützt explizit `scope=children` oder `scope=subtree` unter
  einer Eltern-ID. Bei subtree die Ausgangsgruppe nicht als eigenes Kind zurückgeben.
  Ohne Eltern-ID bedeutet children die Hauptgruppen und subtree alle eigenen Gruppen.
  Suchergebnisse enthalten den Pfad für die Zielauswahl; diese bleibt paginiert.
- Draftfilter: kein `groupId` = alle; UUID = diese Gruppe; `groupId=none` = unzugeordnet.
  `includeDescendants=true` ist nur mit UUID gültig. Besitzer, Gruppe, Suchfilter
  und Rekursionsmodus gehören in den Cursor-Fingerprint. Filter vor Pagination
  anwenden, niemals nur die bereits geladene Seite im Browser gruppieren.
- Zähler heißen `directDraftCount`, `subtreeDraftCount`, `childGroupCount`; nur
  zugängliche lebende Drafts zählen. Für angezeigte Gruppen gesammelt berechnen.
  Listen bleiben wie bestehende Draftlisten live, keine Snapshot-Garantie über
  mehrere Seiten bei parallelen Änderungen. Eigene Strukturänderungen setzen
  betroffene UI-Cursor zurück und laden Zähler/Pfade neu.

## Services, Konkurrenz und API

Neue Services in `lib/groups/service.ts`: Anlegen, Metadaten ändern, Gruppe
verschieben, Gruppe auflösen und `moveDraftsToGroup(actor, draftIds, groupId)`.
Auch Dashboardaktionen verwenden diese Services. Alle Mutationen nehmen zuerst
die bestehende Kontosperre `agentplan:user-storage` und prüfen danach den aktuellen
Kontostatus und Eigentum in der Transaktion. Eltern und Kinder müssen demselben
Besitzer gehören; ein globaler FK allein beweist das nicht.

Beim Gruppenverschieben unter dieser Sperre den Teilbaum der Quelle abfragen:
Quelle selbst oder ein Nachfahre als Ziel ergibt `INVALID_REQUEST`. Erst
nach sämtlichen Prüfungen `parentId` ändern. So können zwei konkurrierende
Verschiebungen nicht durch wechselseitiges Einhängen einen Zyklus erzeugen.
Auch `PATCH` mit Name und Eltern-ID muss vollständig atomar sein.

Beim Auflösen unter derselben Sperre: Quelle und Elternknoten laden, direkte
Drafts mit neuer `groupId` und `updatedAt: now()` aktualisieren, direkte Kinder
mit neuer `parentId` und aktualisiertem Gruppenzeitstempel umhängen, gespeicherte
Intentziele umleiten, dann Quelle entfernen. Alle Schritte in einer Transaktion.
`ON DELETE SET NULL` allein führt Drizzles `updatedAt`-Logik nicht aus und kennt
das übergeordnete Ziel nicht. Für Kinder und Dateien ist deshalb das ausdrückliche
Update erforderlich. Nachfahren der direkten Kinder nicht einzeln umschreiben.

Der Uploadabschluss liest `targetGroupId` zwingend aus dem frisch gesperrten
`lockedIntent`, nicht aus dem älteren Snapshot `intent`. Ein nicht-null Ziel
ownergebunden neu prüfen. Verschieben einer Gruppe erhält ihre ID; Auflösen
ändert den gespeicherten Intent auf den Elternknoten. Auch mehrfaches Auflösen
von Vorfahren vor Abschluss muss zum dann gültigen Ziel führen.

| Endpunkt | Implementierter Vertrag |
| --- | --- |
| `GET /api/v1/groups` | `parentId` optional, `scope=children` als Standard oder `subtree`, `search`, `limit`, `cursor`; Antwort `{ groups, nextCursor }` mit IDs, Eltern-ID, Texten, Zeitstempeln, Pfaden sowie `directDraftCount`, `subtreeDraftCount`, `childGroupCount` und `pendingUploadCount`. |
| `POST /api/v1/groups` | `{ name, description?, parentId?: UUID | null }`; Antwort `201 { group }`. Ohne Eltern-ID Hauptgruppe. |
| `GET /api/v1/groups/:id` | `{ group, ancestors }`; Vorfahren geordnet von der Wurzel zum direkten Elternknoten. |
| `PATCH /api/v1/groups/:id` | `{ name?, description?, parentId? }`; `description: null` leert, `parentId: null` macht Hauptgruppe; weggelassene Felder unverändert. Atomar, mindestens ein Feld. |
| `DELETE /api/v1/groups/:id` | Definierte Auflösen-Operation, `204`; Behälter entfernen, direkte Inhalte eine Ebene höher. Kein rekursives Dateilöschen. |
| `POST /api/v1/drafts/move` | `{ draftIds: UUID[], groupId: UUID | null }`, 1–50 verschiedene IDs; `{ movedCount }` zählt tatsächlich geänderte Zuordnungen. |
| `GET /api/v1/drafts` | Zusätzlich `groupId`, `includeDescendants`; Draftantworten enthalten nullable `groupId`. Pfade im Dashboard gesammelt auflösen. |
| Upload-Endpunkte | `target.groupId` optional nur für neue direkte Uploads/Bundles; Multipart-Feld `groupId` für neue HTML-Drafts. Weglassen oder JSON-null = ohne Gruppe. |

UUID-Parameter dürfen nicht leer sein. Fehlende Eltern-ID in der Gruppenliste
bedeutet die virtuelle Wurzel, nicht alle Gruppen; alle erhält man explizit mit
`scope=subtree`. Unbekannte/fremde Ausgangsgruppen ergeben `NOT_FOUND`.
Lesen verwendet `drafts:read`, Mutationen `drafts:write`, Sessionzugriff das bestehende
Authentifizierungsverfahren. Bestehende Fehlercodes beibehalten: ungültige Formate,
Zyklen und widersprüchliche Optionen `INVALID_REQUEST`; fremde oder fehlende
Ressourcen `NOT_FOUND`. Fehlermeldungen verraten keine fremden Gruppen.

Dateiverschiebungen sind atomar. Erst alle IDs, Live-Zustand und Ziel prüfen, dann
schreiben. Derselbe Ablageort ist ein No-op. Bestehende PATCH-Route für Drafttitel
und Sichtbarkeit nicht um eine weitere Teilmutation erweitern.
`target.groupId` bei `type: "draft"` sowie Gruppenvorgaben für Multipart-Versionen
explizit zurückweisen; Versionsuploads und Restores ändern die Zuordnung nicht.

Audittypen in `lib/audit/events.ts` ergänzen: Gruppe angelegt, geändert, verschoben,
aufgelöst, Draft verschoben. IDs und Änderungsanzahlen genügen. Aufbewahrung und
bestehende Diagnose-/Fehlerhilfen beibehalten, keine Inhalte oder Zugangsdaten loggen.

## Implementierter Umfang und Prüfungen

Die ursprüngliche Schätzung von 8–13 Entwicklungstagen war eine grobe
Planungsgröße, keine Lieferzusage. Browser, Uploadwege, API und CLI sind jetzt
implementiert; der vollständige Prüflauf und die ergänzenden Viewerregressionen
sind bestanden. Der Produktionsrollout wird als anschließender Veröffentlichungsschritt
im PR verfolgt und ist in diesem Commitstand noch ausstehend.

### Datenmodell, Baumoperationen und API

`db/schema.ts` und die additive Migration `drizzle/0017_handy_blazing_skull.sql`
samt `drizzle/meta/0017_snapshot.json` und Journal ergänzen Gruppen, Elternbeziehungen,
Draft-/Intentziele und Indizes. `db/queries/groups.ts` enthält Baumabfragen,
Pfade, Zähler und Pagination. `lib/groups/service.ts`, `access.ts`, `errors.ts`
und `responses.ts` bündeln Mutationen, Eigentumsprüfung und Fehlerabbildung.
`lib/validation/groups.ts` und `lib/api/group-cursor.ts` prüfen Eingaben und Cursor.

Die Routen sind `app/api/v1/groups/route.ts`,
`app/api/v1/groups/[id]/route.ts` und `app/api/v1/drafts/move/route.ts`.
Draftlisten, Serializer und Audittypen wurden erweitert. Gruppenzuordnung und
Rekursionsmodus gehören zum Draftcursor. Die bestehenden Draft-PATCH-Mutationen
wurden nicht um eine zusätzliche Teilmutation erweitert.

Nachweise liegen in `tests/unit/groups.test.ts` und
`tests/integration/groups.test.ts`: zwölf Ebenen, vollständige Pfade, Zähler,
Eigentums-/Kontoprüfung, konkurrierende inverse Verschiebungen, atomare Mehrfachaktionen,
Auflösen und Filterbindung. UUIDs werden unabhängig von Groß-/Kleinschreibung verglichen.

### Dashboard und Uploads

`app/dashboard/groups/page.tsx` und `app/dashboard/groups/[id]/page.tsx` ergänzen
Gruppenübersicht und Gruppeninhalt. `components/dashboard/library-page.tsx` dient
als gemeinsame Dateiansicht für Dashboard und Gruppenseiten. Navigation,
Gruppenkarten und Filter liegen in `group-navigation.tsx`, `group-cards.tsx` und
`file-filters.tsx` unter demselben Komponentenverzeichnis.

`components/dashboard/group-controls.tsx` enthält Breadcrumbs, Zielauswahl,
Anlegen/Bearbeiten/Verschieben/Auflösen sowie Dateiauswahl. Diese Dashboardaktionen
rufen die authentifizierten Gruppen-/Draft-APIs auf; es gibt keine separate
`app/dashboard/groups/actions.ts`. Nach Mutationen werden Routerdaten und die
nachgeladenen Navigationszweige aktualisiert. Dialoge werden außerhalb des
Uploadformulars gerendert, damit verschachtelte Formulare keinen Upload auslösen.

URLs sind `/dashboard`, `/dashboard?groupId=none`, `/dashboard/groups` und
`/dashboard/groups/:id`; Gruppen-Dateifilter verwenden `q`, `includeDescendants`
(`1`/`0`) und `cursor`, direkte Kinder `groupsCursor`. Die REST-API verwendet
für `includeDescendants` weiterhin `true`/`false`. Such-/Filterwechsel und
Strukturänderungen setzen betroffene Cursor zurück.

`components/dashboard/upload-form.tsx` und die Draftdetails zeigen das gewählte
Ziel. Die drei Erstellungswege sind angebunden: Legacy-Multipart über
`lib/drafts/service.ts`/`lib/api/upload.ts`, direkte Uploads über
`lib/uploads/service.ts` und Bundles über `lib/uploads/bundles.ts`.
Abschlüsse verwenden das frisch gesperrte Intentziel; Versionsuploads und
Restores behalten den aktuellen Ablageort. Offene Uploads bleiben kontoweit
sichtbar und zählen nicht als gespeicherte Dateien.

`tests/integration/group-uploads.test.ts` prüft HTML/Bild/Video/Bundle-Ziele,
Versionsrestriktionen, aktuelle Zuordnung nach Verschiebungen und mehrfaches
Auflösen während laufender Einzeldatei-/Bundle-Abschlüsse. Neu ergänzte Fälle
prüfen zusätzlich Gruppenverschieben bei ausstehenden Uploads, Legacy-Erstellung
gegen Auflösen unter der Kontosperre und Admin-Kontolöschung mit Storagebereinigung.
`tests/e2e/groups.spec.ts` enthält vier Browserjourneys einschließlich
390px-Navigation und Zielauswahl über zwölf Ebenen, Fokus/Escape, Mehrfachauswahl
mit Fehlererholung, Öffnen des unveränderlichen Viewers nach Baumänderungen und
Gruppenerstellung innerhalb der Uploadzielauswahl. Diese Browserjourneys und
Lebenszyklustests bestanden im finalen Gesamtcheck. Zusätzlich bestanden drei
Viewerregressionen für öffentliche, private und passwortgeschützte Drafts:
aktuelle und unveränderliche Viewer-/Content-URLs vor und nach Verschieben und
Auflösen, fortgeltende Passwortfreigaben und keine offengelegten Gruppennamen.

### CLI und Dokumentation

Die folgenden Befehle sind implementiert:

```sh
agentplan groups create "Beispiel GmbH" --json
agentplan groups create "Website-Relaunch" --parent <customer-group-id> --json
agentplan groups create "Design" --parent <relaunch-group-id> --json
agentplan groups list --parent <relaunch-group-id> --json
agentplan groups list --recursive --json
agentplan groups move <group-id> --parent <destination-id>
agentplan groups move <group-id> --root
agentplan groups dissolve <group-id> --yes
agentplan upload ./plan.html --group <design-group-id>
agentplan upload ./plan-directory --group <design-group-id>
agentplan list --group <relaunch-group-id> --recursive --json
agentplan list --ungrouped --json
agentplan move <draft-id> --group <design-group-id>
agentplan move <draft-id> <another-draft-id> --ungrouped
```

Die Umsetzung liegt in `packages/cli/src/index.ts`, `api.ts`, `upload-options.ts`,
`arguments.ts` und `group-options.ts`. Gruppen werden über UUIDs angesprochen.
`groups create` unterstützt `--description`; Listen laden ohne `--limit`/`--cursor`
alle Seiten. Widersprüchliche Ziele, ungültige UUIDs, unbekannte Optionen und
falsche Positionsargumente werden vor API-Zugriffen mit Exit 2 abgewiesen.
`move` unterstützt 1–50 verschiedene Draft-IDs; `groups dissolve` verlangt `--yes`.
JSON-Ergebnisse stehen ausschließlich auf stdout, Fehler auf stderr.

`README.md` und `packages/cli/README.md` beschreiben Hierarchie, Suchreichweite,
API-Verträge und Auflösen. `packages/upload-contract` wurde für reine
Gruppenmetadaten nicht verändert. Neue Nachweise sind
`tests/unit/cli-groups.test.ts`, die Erweiterung von
`tests/security/cli-upload-options.test.ts` und die Executable-Journey
`tests/e2e/cli-groups.spec.ts`; bestehende CLI-Journeys bleiben bestehen.
CLI-Version 0.3.0 ist vorbereitet; die Installation des gepackten Tarballs und
die Hilfeausgabe wurden erfolgreich geprüft. Die npm-Veröffentlichung wartet
auf die Anmeldung des Nutzers, nachdem npm mit 401 antwortete.

### Aktueller Prüflauf

| Prüfung | Nachgewiesener Stand |
| --- | --- |
| Frische isolierte Migrationen | Bestanden; neue Gruppentabellen und FKs werden angelegt. |
| Upgrade mit Bestandsdaten | Bestanden über `.data/qa/check-groups-upgrade.mjs`: Migrationen 0000–0016, öffentliche/private/passwortgeschützte Drafts samt Versionen anlegen, 0017 anwenden; alle bisherigen Draft-/Versionsfelder einschließlich Slug, Ablaufdatum, Hash und Storage-Key bleiben unverändert, `group_id` ist null. |
| `npm run check:quick` | Bestanden. |
| CLI-Typecheck und Build | `npm run typecheck -w agentplan-cli` und `npm run build -w agentplan-cli` bestanden. |
| Gezielte CLI-Prüfungen | 66 Unit-/Sicherheitstests, ESLint und Prettier bestanden; Hilfe und Fehlerausgabe am gebauten Executable geprüft. |
| Finaler `npm run check:full` | Bestanden: 440 Unit-/Sicherheits-/Datenbanktests, 37/37 Browser-/CLI-Journeys, CLI- und Produktionsbuild sowie Uploadartefakt-Prüfungen. Ein optionaler Live-Provider-Test wurde übersprungen. |
| Zusätzliche Viewerregression | 3/3 bestanden: öffentliche/private/passwortgeschützte aktuelle und unveränderliche Viewer-/Content-URLs vor/nach Verschieben und Auflösen; bestehende Passwortfreigaben bleiben gültig, Gruppennamen werden nicht offengelegt. |
| CLI-Paket 0.3.0 | Vorbereitet; Tarball-Installation und Hilfeausgabe bestanden. npm-Veröffentlichung wartet auf Nutzeranmeldung (401). |
| Produktion | Autorisierter Veröffentlichungsschritt im PR; in diesem Commitstand noch ausstehend. |

Datenbanktests liefen gegen die verwaltete isolierte QA-Datenbank. Zugangsdaten,
Sessions und Browserartefakte bleiben in `.data/`. Der übersprungene Provider-Test
und lokale Filesystem-Tests belegen keine Provider-CORS- oder
Produktionsstreaming-Eigenschaften. Eine Produktionsprüfung wird separat vom
lokalen Prüflauf dokumentiert.

## Überprüfbare Fertigkriterien

Alle Implementierungskriterien haben einen bestandenen Nachweis; der
Umsetzungsplan steht auf **DONE**. Produktionsrollout und npm-Veröffentlichung
werden als nachgelagerte Veröffentlichungsschritte separat im PR verfolgt.

- [x] Additive Migration lässt sich auf einer frischen isolierten Datenbank anwenden.
- [x] Upgrade mit vor der Gruppenmigration angelegten öffentlichen/privaten/
  passwortgeschützten Drafts und Versionen erhält alle vorherigen Felder und
  setzt die Zuordnung auf null (`.data/qa/check-groups-upgrade.mjs`, isolierte DB).
- [x] Datenmodell und Abfragen unterstützen zwölf Ebenen mit gemischten Inhalten,
  vollständigen Pfaden und direkten/rekursiven Zählern (`tests/integration/groups.test.ts`).
- [x] Breadcrumbs, mobile Navigation und Zielauswahl über zwölf Ebenen sind im
  Browser geprüft (`tests/e2e/groups.spec.ts`, 390px ohne horizontalen Überlauf).
- [x] Selbst-/Nachfahrenziele und fremde Eltern werden abgewiesen; konkurrierende
  inverse Verschiebungen erzeugen keinen Zyklus. Ein ungültiges Elternziel lässt
  den gemeinsam geänderten Namen unverändert (`tests/integration/groups.test.ts`).
- [x] Direkte/rekursive Listen, Suche, Live-Zähler und Pagination sowie
  Besitzer-/Filterbindung der Cursor sind geprüft (`tests/unit/groups.test.ts`,
  `tests/integration/groups.test.ts`).
- [x] Fremde Besitzer und blockierte Konten scheitern auch direkt im Service;
  Lesetoken dürfen lesen, aber nicht mutieren; fremde Pfade werden nicht geliefert.
- [x] Dateimehrfachverschiebung ist atomar und idempotent; doppelte, fehlende,
  abgelaufene/fremde IDs und leere/übergroße Auswahl werden abgewiesen.
- [x] Gruppenverschiebung erhält Draft-IDs, direkte Zuordnung und Draftzeitstempel;
  Pfade und Zähler der bisherigen und neuen Vorfahren ändern sich korrekt.
- [x] Auflösen befördert direkte Dateien und Kinder zur Elterngruppe beziehungsweise
  zur Wurzel, erhält tiefere Inhalte und aktualisiert den Draftzeitstempel.
- [x] Aktive Einzeldatei- und Bundle-Intents folgen mehrfachem Auflösen während
  laufender Abschlussvalidierung; wiederholter Abschluss bleibt idempotent
  (`tests/integration/group-uploads.test.ts`).
- [x] Gruppenverschieben während eines neuen Uploads sowie beide Legacy-Multipart-
  Reihenfolgen unter der Kontosperre sind geprüft, einschließlich Ablehnung
  fehlender/fremder Ziele vor Storage-Schreiben (`tests/integration/group-uploads.test.ts`).
- [x] Neue HTML-/Bild-/Video-/Bundle-Drafts erhalten das Ziel; ausstehende
  Versionsuploads sowie Legacy-/Bundle-Restores behalten die aktuelle Zuordnung
  nach einer Verschiebung (`tests/integration/group-uploads.test.ts`).
- [x] Direkte Kontolöschung kaskadiert den Gruppenbaum trotz Selbstreferenz;
  gelöschte und abgelaufene Drafts fehlen in Gruppenzählern und Listen.
- [x] Der vollständige Admin-Kontolöschdienst samt Storagebereinigung ist mit
  einem verschachtelten Gruppenbaum geprüft (`tests/integration/group-uploads.test.ts`).
- [x] Private, öffentliche und passwortgeschützte aktuelle und unveränderliche
  Viewer-/Content-URLs verhalten sich vor/nach Verschieben und Auflösen korrekt;
  vorhandene Passwortfreigaben bleiben gültig, Gruppennamen werden nicht offengelegt
  (3/3 zusätzliche Browserregressionen).
- [x] Browserjourneys bestehen: Hierarchie, Uploads, Mehrfachauswahl, Suche,
  Verschieben/Auflösen, Uploadzielerstellung, Tastatur und 390px ohne Überlauf.
- [x] Gebaute CLI legt Untergruppen an, listet rekursiv, lädt Datei und Bundle hoch,
  verschiebt Gruppen/Dateien und löst Gruppen auf; ihre Argumentprüfung und
  bestehende CLI-Befehle sind im finalen vollständigen Lauf geprüft.
- [x] `npm run check:quick` besteht; Datenbanktests wurden im vollständigen
  Lauf tatsächlich ausgeführt. Der Index gibt den abgeschlossenen Implementierungsstatus wieder.
- [x] Finaler `npm run check:full` besteht nach den letzten Implementierungsänderungen.

## Umfang und Wartung

Umsetzung nur in den genannten Dashboarddateien, `components/dashboard/`, neuen
Gruppenrouten und bestehenden Draft-/Uploadrouten unter `app/api/v1/`, `db/schema.ts`,
`db/queries/`, `drizzle/`, neuer `lib/groups/`, `lib/drafts/service.ts`,
`lib/uploads/service.ts`, `lib/uploads/bundles.ts`, `lib/api/`, `lib/validation/`,
`lib/audit/events.ts`, den genannten CLI-Quelldateien, genannten Tests,
`README.md`, `packages/cli/README.md` und `plans/`. Shared-Contract-Dateien nur bei
begründetem gemeinsamen Vertrag. Keine allgemeine Uploadrefaktorierung.

Viewer/Sandbox, Storageadapter, Billing, Tokenmodell, Teamrechte, Cloudressourcen
und allgemeines Redesign liegen außerhalb. Gruppen sind persönliche Organisation,
kein neuer Autorisierungskontext. Spätere Freigaben und Verknüpfungen separat planen.

Die ursprüngliche reine Planungsgrenze wurde durch die späteren Nutzeraufträge
zur vollständigen Implementierung und zur anschließenden Veröffentlichung in
Produktion erweitert. Der Produktionsrollout ist nach erfolgreicher Abnahme
autorisiert. Eine separate PR ist nicht Voraussetzung des Nutzerauftrags.
Vorhandene Änderungen nicht überschreiben. Wenn die Umsetzung andere Besitzer,
Mehrfachablage oder ein neues Freigabe-/Storagemodell benötigt, zuerst den Entwurf
aktualisieren. Bei Abweichungen tragender Annahmen oder wiederholt fehlschlagenden
Checks Ursachen berichten und den Plan korrigieren; keine Prüfungen umgehen.

Reviews fokussieren auf Baumzyklen, Eigentumsprüfung in rekursiven Abfragen,
Auflösen unter Konkurrenz, aktuelle Intentziele und pfadunabhängige stabile IDs.
Neue Erstellungswege müssen die Gruppenzuordnung ausdrücklich unterstützen.

## Prüfstand dieses Plans

Der Plan dokumentiert die implementierte mehrstufige Organisation und die
bestandene Gesamtprüfung. Die frühere flache Projektebene wurde vollständig ersetzt;
Verknüpfungen, Tags, Archiv und Team-/Gruppenfreigaben bleiben spätere Erweiterungen.

Der finale Gesamtcheck bestand mit 440 Unit-/Sicherheits-/Datenbanktests und
37/37 Browser-/CLI-Journeys. CLI- und Produktionsbuild, Uploadartefakt-Prüfungen
und der zusätzliche Bestandsdaten-Migrationstest bestanden ebenfalls. Ein
optionaler Live-Provider-Test wurde übersprungen. Zusätzlich bestanden 3/3
Viewerregressionen für alle Sichtbarkeiten sowie Installation und Hilfeausgabe
des CLI-0.3.0-Tarballs. Die Implementierung und ihre Abnahme sind abgeschlossen.

Dieser Stand enthält keinen allgemeinen Sicherheits-, Performance- oder
Abhängigkeitsaudit und behauptet weder einen abgeschlossenen Produktionsrollout
noch eine bestandene Providerprüfung. Der autorisierte Produktionsrollout wird
als Veröffentlichungsschritt im PR verfolgt und ist in diesem Commitstand noch
ausstehend. Die npm-Veröffentlichung wartet auf Nutzeranmeldung (401).
