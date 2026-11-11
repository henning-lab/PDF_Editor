# PDF Editor

Alle PDF Werkzeuge in einer Web App: zusammenfügen, teilen, komprimieren, bearbeiten, unterschreiben, digital signieren, umwandeln, Texterkennung (OCR) und vieles mehr.

**Direkt nutzen:** https://henning-lab.github.io/PDF_Editor/

## Datenschutz

Alles läuft in deinem Browser. Deine Dateien werden nicht hochgeladen und verlassen dein Gerät nicht. Signaturzertifikate werden verschlüsselt im Speicher deines Browsers abgelegt.

Einzige Ausnahme: Beim digitalen Signieren mit Zeitstempel wird ein Prüfwert (Hash, nicht das Dokument) an einen öffentlichen Zeitstempeldienst geschickt.

## Funktionen

* **Organisieren:** zusammenfügen, teilen, Seiten sortieren, drehen, löschen, extrahieren, mehrere Seiten pro Blatt, zuschneiden, Seitenformat ändern
* **Bearbeiten:** Text, Bilder, Formen, Formulare ausfüllen, schwärzen, Wasserzeichen, Seitenzahlen, Kopf und Fußzeile, übereinanderlegen
* **Unterschreiben:** zeichnen, tippen (Handschrift-Schriften) oder als Bild
* **Digital signieren (PAdES):** eigenes Signaturzertifikat erstellen oder .p12 importieren, sichtbarer Signaturstempel, Zeitstempel nach RFC 3161, Signaturzertifikat als letzte Seite, Signaturen prüfen
* **Sicherheit:** verschlüsseln und Passwortschutz entfernen
* **In PDF umwandeln:** Word (DOCX), Excel (XLSX, XLS, ODS, CSV), PowerPoint (PPTX), Bilder (inkl. HEIC), DjVu, HTML, Markdown, Text, EPUB
* **Aus PDF umwandeln:** Word, Excel, PowerPoint, Bilder, Text, HTML, PDF/A
* **Weitere:** komprimieren, optimieren, Graustufen, leere Seiten entfernen, OCR (Deutsch, Englisch, Französisch, Spanisch, Italienisch), PDFs vergleichen, reparieren

## Rechtliche Einordnung der digitalen Signatur

Eine Signatur mit einem selbst erstellten Zertifikat ist eine elektronische Signatur nach Art. 25 eIDAS Verordnung. Sie ist fälschungssicher (jede Änderung wird erkannt) und genügt z. B. der Textform. Wo das Gesetz die Schriftform verlangt, ist eine qualifizierte elektronische Signatur (QES) eines qualifizierten Vertrauensdiensteanbieters nötig. Ein solches Zertifikat (.p12) kann importiert werden.

## Entwicklung

```bash
npm install
npm run build        # baut die statische Seite nach docs/
npm run serve        # lokaler Server
node tests/run.mjs   # automatische Tests (Playwright, Chromium)
```

`docs/` wird von GitHub Pages ausgeliefert (Branch `main`, Ordner `/docs`).

## Verwendete Open Source Komponenten

pdf-lib, fontkit (MIT) · PDF.js (Apache 2.0) · Ghostscript WASM (AGPL 3.0) · qpdf WASM (Apache 2.0) · Tesseract.js (Apache 2.0) · DjVu.js (GPL 2.0) · docx-preview (Apache 2.0) · ExcelJS, docx, PptxGenJS, marked, heic2any, UTIF (MIT) · SheetJS (Apache 2.0) · JSZip (MIT) · node-forge, PKI.js, asn1.js (BSD) · Lucide Icons (ISC) · Schriften: Liberation (OFL), Carlito, Caladea (OFL), DejaVu (frei), Great Vibes, Dancing Script, Allura, Sacramento, Mr Dafoe, Caveat (OFL), Homemade Apple (Apache 2.0).

Wegen der GPL und AGPL Komponenten muss der Quellcode dieses Projekts öffentlich verfügbar bleiben.
