# Popular Live Google Play Upload Checklist

## Prepared Files

- Signed bundle: `artifacts/Popular-Live-1.1.39-42.aab`
- Store icon: `listing/assets/app-icon-512.png`
- Feature graphic: `listing/assets/feature-graphic-1024x500.png`
- English title, short description, full description, and release notes: `listing/en-US/`
- Data safety worksheet: `data-safety.md`

## Console Values

- App name: Popular Live
- Package name: `com.greenlive.app`
- Version name: `1.1.39`
- Version code: `42`
- Category: Social
- Contact email: `carelive785@gmail.com`
- Privacy policy: `https://fardin7864.github.io/Yolo-live/privacy-policy.html`
- Account deletion: `https://fardin7864.github.io/Yolo-live/account-deletion.html`

## Required Manual Console Work

1. Create or select the Play Console app whose package name is `com.greenlive.app`.
2. Complete App access and provide a working review account if login is required.
3. Complete Ads, Content rating, Target audience, News, Data safety, Government apps, Financial features, and Health declarations accurately.
4. Disclose user-generated content, live communication, virtual gifts, wallet activity, and simulated/social mini-games.
5. Upload at least two real phone screenshots. Four portrait screenshots at 1080x1920 or higher are recommended.
6. Upload the AAB to Internal testing first and resolve every Play pre-launch or policy warning.
7. Confirm Play App Signing. The bundle is signed with the existing Popular Live upload key.
8. Promote the tested release only after the Console permits production access.

## Build Command

Run from `android/` after generating native config for the Play channel:

`APP_DISTRIBUTION=play-store NODE_ENV=production ./gradlew bundleRelease`

The Play build opens future updates in Google Play and excludes `REQUEST_INSTALL_PACKAGES`. Direct-distribution APK builds continue using the in-app APK installer.
