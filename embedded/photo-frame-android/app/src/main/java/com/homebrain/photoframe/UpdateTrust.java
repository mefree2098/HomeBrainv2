package com.homebrain.photoframe;

import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/** Small platform-independent trust boundary, also exercised on the host JVM. */
final class UpdateTrust {
    static final int MAX_BYTES = 16 * 1024 * 1024;
    static String digest(byte[] bytes) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
    static void verify(byte[] key, String fingerprint, byte[] payload, byte[] signature) throws Exception {
        if (!digest(key).equals(fingerprint)) throw new SecurityException("The hub signing key changed; pair this frame again");
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(key)));
        verifier.update(payload);
        if (!verifier.verify(signature)) throw new SecurityException("Invalid update signature");
    }
    static void checkUpgrade(long installed, long target, long bytes) {
        if (target <= installed || target > 2100000000L) throw new SecurityException("Updates must have a newer version code");
        if (bytes < 100 || bytes > MAX_BYTES) throw new SecurityException("Invalid update size");
    }
    static void checkApk(String expectedPackage, String archivePackage, long expectedVersion, long archiveVersion, byte[] installedCertificate, byte[] archiveCertificate) {
        if (!expectedPackage.equals(archivePackage) || archiveVersion != expectedVersion) throw new SecurityException("APK package or version does not match the release");
        if (installedCertificate.length == 0 || !MessageDigest.isEqual(installedCertificate, archiveCertificate)) throw new SecurityException("APK signing certificate does not match the installed app");
    }
    private UpdateTrust() { }
}
