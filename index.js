const express = require('express');
const session = require('express-session');
const { ExpressOIDC } = require('@okta/oidc-middleware');
const { ConfidentialClientApplication, CryptoProvider } = require('@azure/msal-node');
const { GoogleAuth } = require('google-auth-library');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.EXPRESS_SECRET,
  resave: true,
  saveUninitialized: false
}));

const oidc = new ExpressOIDC({
  issuer: process.env.OKTA_ISSUER,
  client_id: process.env.OKTA_CLIENT_ID,
  client_secret: process.env.OKTA_CLIENT_SECRET,
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${port}`,
  scope: 'openid profile',
  routes: {
    login: {
      path: '/login'
    },
    loginCallback: {
      path: '/authorization-code/callback',
      afterCallback: '/profile'
    }
  }
});

app.use(oidc.router);

const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  }
};

const msalClient = new ConfidentialClientApplication(msalConfig);

const cryptoProvider = new CryptoProvider();
const AZURE_REDIRECT_URI = (process.env.APP_BASE_URL || `http://localhost:${port}`) + '/auth/azure/callback';
const AZURE_SCOPES = ["https://graph.microsoft.com/.default"]; // Or more specific delegated scopes like "User.Read"

const googleAuth = new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

app.get('/', (req, res) => {
  res.send(`
    <h1>Hello World!</h1>
    <p>This is the public home page.</p>
    <a href="/login">Login with Initial IDP</a>
  `);
});

app.get('/profile', oidc.ensureAuthenticated(), (req, res) => {
  const user = req.userContext.userinfo;
  res.send(`
    <h1>Welcome, ${user.name}!</h1>
    <h2>Okta Token Details:</h2>
    <pre>${JSON.stringify(req.userContext, null, 2)}</pre>
    <hr>
    <h2>Search with Google Discovery Engine</h2>
    <form action="/search" method="post">
      <input type="text" name="query" placeholder="Enter your search query" required>
      <button type="submit">Search</button>
    </form>
  `);
});

app.post('/search', oidc.ensureAuthenticated(), async (req, res, next) => {
    const searchQuery = req.body.query;

    if (!searchQuery) {
        return res.status(400).send("Search query is missing.");
    }
    req.session.searchQuery = searchQuery;

    try {
        const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
        req.session.pkceVerifier = verifier;
        req.session.authState = cryptoProvider.createNewGuid();

        const authCodeUrlParameters = {
            scopes: AZURE_SCOPES,
            redirectUri: AZURE_REDIRECT_URI,
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            state: req.session.authState,
        };

        const authCodeUrl = await msalClient.getAuthCodeUrl(authCodeUrlParameters);
        res.redirect(authCodeUrl);

    } catch (error) {
        console.error("Error during Azure AD auth initiation:", error);
        next(error);
    }
});

app.get('/auth/azure/callback', oidc.ensureAuthenticated(), async (req, res, next) => {
    if (req.query.state !== req.session.authState) {
        console.error("State mismatch error");
        return res.status(400).send("Error: State mismatch. Potential CSRF attack.");
    }

    const tokenRequest = {
        code: req.query.code,
        scopes: AZURE_SCOPES,
        redirectUri: AZURE_REDIRECT_URI,
        codeVerifier: req.session.pkceVerifier,
    };

    const searchQuery = req.session.searchQuery;
    delete req.session.authState;
    delete req.session.pkceVerifier;
    delete req.session.searchQuery;

    if (!searchQuery) {
        return res.status(400).send("Search query not found in session. Please try searching again.");
    }

    try {
        const azureAuthResponse = await msalClient.acquireTokenByCode(tokenRequest);

        const azureIdToken = azureAuthResponse.idToken;
        if (!azureIdToken) {
            throw new Error("Azure AD ID token not found in authentication response. Cannot perform Workforce Identity Federation.");
        }

        const stsTokenResponse = await fetch('https://sts.googleapis.com/v1/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                audience: process.env.GOOGLE_WIF_AUDIENCE,
                scope: 'https://www.googleapis.com/auth/cloud-platform',
                requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
                subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
                subject_token: azureIdToken,
            })
        });

        if (!stsTokenResponse.ok) {
            const errorBody = await stsTokenResponse.text();
            console.error("STS Token Exchange Error Body:", errorBody);
            throw new Error(`Google STS token exchange failed with status ${stsTokenResponse.status}: ${errorBody}`);
        }

        const googleFederatedCredentials = await stsTokenResponse.json();
        const googleToken = googleFederatedCredentials.access_token;

        if (!googleToken) {
            throw new Error("Failed to obtain Google Cloud access token from STS response.");
        }
        const discoveryEngineEndpoint = `https://discoveryengine.googleapis.com/v1alpha/projects/${process.env.DISCOVERY_PROJECT_ID}/locations/global/collections/default_collection/engines/${process.env.DISCOVERY_ENGINE_DATA_STORE_ID}/servingConfigs/default_search:search`;

        const discoveryResponse = await fetch(discoveryEngineEndpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${googleToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({"query":searchQuery,"pageSize":10,"queryExpansionSpec":{"condition":"AUTO"},"spellCorrectionSpec":{"mode":"AUTO"},"relevanceScoreSpec":{"returnRelevanceScore":true},"languageCode":"en-US","naturalLanguageQueryUnderstandingSpec":{"filterExtractionCondition":"ENABLED"},"userInfo":{"timeZone":"America/New_York"}})
        });

        const searchResults = await discoveryResponse.json();
        if (!discoveryResponse.ok) {
            console.error("Error from Discovery Engine:", searchResults);
            throw new Error(`Discovery Engine API request failed with status ${discoveryResponse.status}: ${JSON.stringify(searchResults)}`);
        }

        res.send(`
            <h1>Search Results</h1>
            <h2>Query: ${searchQuery}</h2>
            <h3>Azure AD Token (obtained via interactive flow):</h3>
            <pre>${JSON.stringify(azureAuthResponse, null, 2)}</pre>
            <h3>Google Cloud Access Token:</h3>
            <pre>${googleToken}</pre>
            <h3>Discovery Engine Results:</h3>
            <pre>${JSON.stringify(searchResults, null, 2)}</pre>
            <h2>Search with Google Discovery Engine</h2>
            <form action="/search" method="post">
              <input type="text" name="query" placeholder="Enter your search query" required>
              <button type="submit">Search</button>
            </form>
        `);

    } catch (error) {
        console.error("Error in Azure AD callback or search execution:", error);
        res.status(500).send(`
            <h1>Error</h1>
            <p>An error occurred during the search process.</p>
            <p>Details: ${error.message}</p>
            <pre>${error.stack ? error.stack : JSON.stringify(error, null, 2)}</pre>
        `);
    }
});

app.get('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
});

oidc.on('ready', () => {
  app.listen(port, () => console.log(`App started on port ${port}`));
});

oidc.on('error', err => {
  console.error('OIDC Error: ', err);
});

// Basic error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send(`
        <h1>Something broke!</h1>
        <pre>${err.message}</pre>
    `);
});
