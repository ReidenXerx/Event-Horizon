/**
 * Archives this codebase did not write.
 *
 * A ZIP reader tested only against a ZIP built by the same assumptions agrees
 * with itself about where data starts and which lengths to trust, and that
 * agreement is not evidence. Both fixtures below come from real writers.
 *
 * DOTNET_ZIP  — System.IO.Compression.ZipArchive. Three entries, all deflate,
 *               one nested in a subdirectory. No extra fields anywhere.
 *
 * SEVENZIP_WITH_LOCAL_EXTRA — written by 7-Zip 26.01 (the tool that actually
 *               produces .ehcoll files), then patched to carry an 8-byte extra
 *               field in ONE local header. Two properties neither stock writer
 *               gave us, and both are code paths that were silently untested:
 *
 *                 - stored.bin uses method 0, so corrupting its payload does
 *                   NOT break inflate. Only the CRC can catch that, which is
 *                   the one way to prove the CRC check does anything.
 *                 - manifest.json's LOCAL extra length is 8 while its central
 *                   extra length is 36. A reader that computes the data offset
 *                   from the central header, or ignores the local extra field,
 *                   reads from the wrong byte and must fail.
 *
 *               The patched archive was verified with the real 7z, which
 *               reports "Everything is Ok" and lists both entries at their
 *               correct sizes -- so it is a valid archive, and any
 *               disagreement is the reader's fault rather than the fixture's.
 */

/** The exact bytes both fixtures were asked to store, for content comparison. */
export const MANIFEST_TEXT =
  '{"schema":1,"mods":[' + '{"id":"x"},'.repeat(200) + '{"id":"last"}]}';

/** Built by .NET. Three deflate entries, no extra fields. */
export const DOTNET_ZIP =
  "UEsDBBQAAAAIAE2KHV0ItTvUQQAAALsIAAANAAAAbWFuaWZlc3QuanNvbqtWKk7OSM1NVLIy1FHK" +
  "zU8pVrKKrlbKTFGyUqpQqtUZZY6Gw2giGE0Eo4lgNBGMJoLRRFAxCBJBTmJxiVJtbC0AUEsDBBQA" +
  "AAAIAE2KHV2sKpPYBAAAAAIAAAAIAAAAdGlueS50eHTLyAQAUEsDBBQAAAAIAE2KHV2Y7SkxFQAA" +
  "ABMAAAAOAAAAc3ViL25lc3RlZC50eHTLSy0uSU1RSM7PK0nNK1HISC1KBQBQSwECFAAUAAAACABN" +
  "ih1dCLU71EEAAAC7CAAADQAAAAAAAAAAAAAAAAAAAAAAbWFuaWZlc3QuanNvblBLAQIUABQAAAAI" +
  "AE2KHV2sKpPYBAAAAAIAAAAIAAAAAAAAAAAAAAAAAGwAAAB0aW55LnR4dFBLAQIUABQAAAAIAE2K" +
  "HV2Y7SkxFQAAABMAAAAOAAAAAAAAAAAAAAAAAJYAAABzdWIvbmVzdGVkLnR4dFBLBQYAAAAAAwAD" +
  "AK0AAADXAAAAAAA=";

/** Built by 7-Zip, with a stored entry and a local extra field. */
export const SEVENZIP_WITH_LOCAL_EXTRA =
  "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" +
  "AAACAAIAuwAAAJkIAAAAAA==";

/** Byte offset of manifest.json's CRC-32 inside SEVENZIP_WITH_LOCAL_EXTRA. */
export const SEVENZIP_MANIFEST_CRC_OFFSET = 2217;

/** Byte offset of stored.bin's CRC-32 inside SEVENZIP_WITH_LOCAL_EXTRA. */
export const SEVENZIP_STORED_CRC_OFFSET = 2312;

/**
 * A .ehcoll-SHAPED package, written by 7-Zip: manifest.json plus a real
 * bundled/<sha256>.zip whose name is the actual SHA-256 of its bytes, exactly
 * as a built package names them. It also carries a DIRECTORY entry, which a
 * reader must skip rather than try to extract.
 *
 * This exists because writeBundledArchive had no tests: removing its
 * extraction entirely, and pointing it at the wrong entry, both left the suite
 * green.
 */
export const EHCOLL_WITH_BUNDLED =
  "UEsDBBQAAAAAAFOOHV0AAAAAAAAAAAAAAAAIAAAAYnVuZGxlZC9QSwMEFAAAAAgAU44dXR+/svR/" +
  "AAAAsAAAAEwAAABidW5kbGVkLzkwNTYxNTZjMzVhYTU1MWRjYzk1MGY5MzIyYTNkN2QyZmU0NmU1" +
  "N2JkZTIwM2RhY2NhNzczYjVlNjY5Mzg5YWEuemlwdYw9CoNAEIVn81eYNkWawBap06YSO5tFWLC2" +
  "EUcRRRddC/EK4plsbL2Bd3FXbRT8hjczPGYeZ9ebARq3+3hjE9KX2rWeSk4e2HGKPyyFKFBiFlCR" +
  "VlGcUb+WWHJGLhacvX9hheq2DzM2k8AbZJv0w38icICz+2O5UeWpaS7uDFBLAwQUAAAACABTjh1d" +
  "CLU71D4AAAC7CAAADQAAAG1hbmlmZXN0Lmpzb27txjEKwCAQRcG7vNom7V4lpJAYSCBisRaC7N29" +
  "hsWfaiZ+v0/N2JGorTh2Tr6CMYikqqqqqqq6Q//snbhiAVBLAQI/ABQAAAAAAFOOHV0AAAAAAAAA" +
  "AAAAAAAIACQAAAAAAAAAEAAAAAAAAABidW5kbGVkLwoAIAAAAAAAAQAYANRzdMDFN90BAAAAAAAA" +
  "AADUc3TAxTfdAVBLAQI/ABQAAAAIAFOOHV0fv7L0fwAAALAAAABMACQAAAAAAAAAIAAAACYAAABi" +
  "dW5kbGVkLzkwNTYxNTZjMzVhYTU1MWRjYzk1MGY5MzIyYTNkN2QyZmU0NmU1N2JkZTIwM2RhY2Nh" +
  "NzczYjVlNjY5Mzg5YWEuemlwCgAgAAAAAAABABgAvAhwwMU33QEAAAAAAAAAAE7+dMDFN90BUEsB" +
  "Aj8AFAAAAAgAU44dXQi1O9Q+AAAAuwgAAA0AJAAAAAAAAAAgAAAADwEAAG1hbmlmZXN0Lmpzb24K" +
  "ACAAAAAAAAEAGADjmnTAxTfdAQAAAAAAAAAA45p0wMU33QFQSwUGAAAAAAMAAwBXAQAAeAEAAAAA";

/** SHA-256 of the inner archive, and its entry path inside the package. */
export const BUNDLED_SHA = "9056156c35aa551dcc950f9322a3d7d2fe46e57bde203dacca773b5e669389aa";
export const BUNDLED_ENTRY = `bundled/${BUNDLED_SHA}.zip`;

/** The inner archive is a real zip of 176 bytes; content is compared, not just length. */
export const INNER_ZIP_BYTES = 176;
