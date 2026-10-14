package com.homebrain.photoframe;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;

/** Adversarial trust checks; runs on a host JDK without an emulator or JUnit. */
public final class UpdateTrustCheck {
    interface CheckedAction { void run() throws Exception; }
    static void rejects(CheckedAction action) throws Exception {
        try { action.run(); } catch (SecurityException expected) { return; }
        throw new AssertionError("Untrusted update was accepted");
    }
    public static void main(String[] arguments) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048);
        KeyPair hub = generator.generateKeyPair();
        byte[] key = hub.getPublic().getEncoded();
        byte[] payload = "{\"versionCode\":2,\"sha256\":\"artifact\"}".getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(hub.getPrivate()); signer.update(payload);
        byte[] signature = signer.sign();
        String pin = UpdateTrust.digest(key);
        UpdateTrust.verify(key, pin, payload, signature);
        rejects(() -> UpdateTrust.verify(key, "0".repeat(64), payload, signature));
        rejects(() -> UpdateTrust.verify(key, pin, "altered manifest".getBytes(StandardCharsets.UTF_8), signature));
        KeyPair impostor = generator.generateKeyPair();
        rejects(() -> UpdateTrust.verify(impostor.getPublic().getEncoded(), pin, payload, signature));
        byte[] damaged = signature.clone(); damaged[0] ^= 1;
        rejects(() -> UpdateTrust.verify(key, pin, payload, damaged));
        UpdateTrust.checkUpgrade(1, 2, 1024);
        rejects(() -> UpdateTrust.checkUpgrade(2, 2, 1024));
        rejects(() -> UpdateTrust.checkUpgrade(3, 2, 1024));
        rejects(() -> UpdateTrust.checkUpgrade(1, 2, UpdateTrust.MAX_BYTES + 1L));
        byte[] certificate = new byte[]{1, 2, 3};
        UpdateTrust.checkApk("com.homebrain.photoframe", "com.homebrain.photoframe", 2, 2, certificate, certificate.clone());
        rejects(() -> UpdateTrust.checkApk("com.homebrain.photoframe", "com.other.app", 2, 2, certificate, certificate));
        rejects(() -> UpdateTrust.checkApk("com.homebrain.photoframe", "com.homebrain.photoframe", 2, 3, certificate, certificate));
        rejects(() -> UpdateTrust.checkApk("com.homebrain.photoframe", "com.homebrain.photoframe", 2, 2, certificate, new byte[]{9}));
        System.out.println("OTA trust checks passed: pinned hub, signed payload, APK signer/package/version, size and downgrade rejection.");
    }
}
