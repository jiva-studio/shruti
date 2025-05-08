# App Store Certificates

During the build and release process, you will need to sign the app with your Apple Developer certificates. To do so, you must have all the certificates and private key in the keychain. Provisioning profiles are also needed.

1. Create a certificate signing request (CSR) using Keychain Access. 
   - Open Keychain Access on your Mac.
   - In the menu bar, select `Keychain Access` > `Certificate Assistant` > `Request a Certificate From a Certificate Authority`.
   - Select "Saved to disk" for the CSR option. Save the CSR file to your computer.
   - Save the private key also. This is important for signing the app. Without the private key, all the certificates will be untrusted.

2. Go to the [Apple Developer Certificates](https://developer.apple.com/account/resources/certificates/list) page and create a new certificate. Use the CSR you created in step 1. 
   - Create a Development certificate.
   - Create a Distribution certificate.

3. Got to the [Apple Developer Provisioning Profiles](https://developer.apple.com/account/resources/profiles/list) page and create a new provisioning profile. 
   - Select the type of provisioning profile you need (Development or Distribution).
   - Select the app ID, devices, and certificate you created in step 2.
   - Download the provisioning profile.

4. Download all the certificates and provisioning profiles to your computer. 
   - The certificates will be in `.cer` format.
   - The provisioning profiles will be in `.mobileprovision` format.
   - Private key will be in `.p12` format.

5. Archive the certificates, provisioning profiles, and private key.

6. Convert the archive to base64 format. 
   - Use the following command to convert the archive to base64 format:
     ```bash
     base64 -i <archive_file> -o <output_file>
     ```
7. Update `APPLE_CERTIFICATES` repository secret.

8. See `Fastfile` for file names and provisioning profile names. Defaults are:
    - `AKd Studios.p12`
    - `development.cer`
    - `distribution.cer`
    - `Lectorium_Development.mobileprovision`  (profile name: `Lectorium Development`)
    - `Lectorium_Distribution.mobileprovision` (profile name: `Lectorium Distribution`)
