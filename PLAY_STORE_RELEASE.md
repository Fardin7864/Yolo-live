Play Store release setup for this app:

1. The Android release signing config reads from `android/key.properties`.
2. The upload keystore file should live at `android/app/carelive-upload-key.jks`.
3. Build the Play Store bundle with:
   `cd android && JAVA_HOME=$(/usr/libexec/java_home -v 17) NODE_ENV=production ./gradlew bundleRelease`
4. The generated bundle will be:
   `android/app/build/outputs/bundle/release/app-release.aab`

Important:
- Keep the `.jks` file and `android/key.properties` backed up somewhere safe.
- Losing the upload key makes future Play Store uploads much harder.
- `versionCode` must increase for each new Play upload.
