# Word revision fixture

Synthetic content only. Opened and saved by Microsoft Word 16.0, then saved again after Revisions.AcceptAll
with TrackRevisions off, using a new identified private instance. The owned document closed and Word quit;
the existing Word PIDs 7276 and 18284 remained. Generation evidence is in
artifacts/v0.9.107-release-fixes/a7-word-fixture at the repository workspace root.

Word reported revision types 2, 1, 14, 15, 2, 3, 10 (delete, insert, moved-from, moved-to and property revisions),
and one comment. The input seed also included a deleted field instruction; Word normalized it when saving.
The namespace-specific unit cases separately cover w:delInstrText and standalone w:delText.

- word-revisions.docx SHA256: 279b8699cc370e815c803f4bd4f1d1f18b304fe46861e20ebd4f1552cb03d7de
- word-accepted.docx SHA256: 0152b59f9c5412869752735f0d1921ccd1e857e1140d8b1072b5e0bb6f3568a9

Word's accepted Content.Text (CR is the paragraph separator):
Start NEW CLAUSE end.[CR][CR]Moved clause.[CR]Field result stays.[CR]Formatting stays.[CR]Commented clause.[CR]
The existing plain extractor omits empty paragraphs and joins nonempty blocks with two LF characters.
