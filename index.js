const express = require('express');
const session = require('express-session');
const path = require('path');
const { ExpressOIDC } = require('@okta/oidc-middleware');
const { ConfidentialClientApplication, CryptoProvider } = require('@azure/msal-node');

const app = express();
const port = process.env.PORT || 3000;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
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
    },
    logout: {
      path: '/logout'
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
const AZURE_SCOPES = ["https://graph.microsoft.com/.default"];

app.get('/', (req, res) => {
  res.render('index', { title: 'Example Initial Landing Page' });
});

app.get('/profile', oidc.ensureAuthenticated(), (req, res) => {
  const user = req.userContext.userinfo;
  res.render('profile', {
    title: 'User Profile',
    user: user,
    userContext: req.userContext
  });
});

app.post('/search', oidc.ensureAuthenticated(), async (req, res, next) => {
    const searchQuery = req.body.query;

    if (!searchQuery) {
        return res.status(400).render('error', {
            title: 'Search Error',
            message: 'Search query is missing.',
            details: 'Please enter a search term.',
            req: req
        });
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
        return next(error);
    }
});

app.get('/auth/azure/callback', oidc.ensureAuthenticated(), async (req, res, next) => {
    if (req.query.state !== req.session.authState) {
        console.error("State mismatch error");
        return res.status(400).render('error', {
            title: 'Authentication Error',
            message: 'State mismatch. Potential CSRF attack.',
            details: 'The authentication state did not match. This could indicate a security issue. Please try logging in again.',
            stack: process.env.NODE_ENV !== 'production' ? 'State mismatch details hidden for security.' : undefined,
            req: req
        });
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
        return res.status(400).render('error', {
            title: 'Search Error',
            message: 'Search query not found in session.',
            details: 'Your session might have expired or the search query was lost. Please try searching again from the profile page.',
            stack: null,
            req: req
        });
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
            body: JSON.stringify({"query":searchQuery,
              "pageSize":10,
              "spellCorrectionSpec":{"mode":"AUTO"},
              "relevanceScoreSpec":{"returnRelevanceScore":true},
              "languageCode":"en-US",
              "naturalLanguageQueryUnderstandingSpec":{"filterExtractionCondition":"ENABLED"},
              "userInfo":{"timeZone":"America/New_York"}})
        });

        const searchResults = await discoveryResponse.json();
        if (!discoveryResponse.ok) {
            console.error("Error from Discovery Engine:", searchResults);
            throw new Error(`Discovery Engine API request failed with status ${discoveryResponse.status}: ${JSON.stringify(searchResults)}`);
        }

        res.render('search-results', {
            title: 'Search Results',
            searchQuery: searchQuery,
            azureAuthResponse: azureAuthResponse,
            googleToken: googleToken,
            searchResults: searchResults,
            req: req
        });

    } catch (error) {
        console.error("Error in Azure AD callback or search execution:", error);
        return next(error);
    }
});

app.get('/logout', (req, res) => {
  if (req.logout && typeof req.logout === 'function') { 
    req.logout(); 
    res.redirect('/');
  }
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
    res.status(err.status || 500);
    res.render('error', {
        title: 'Error',
        message: err.message || 'Something went wrong!',
        details: err.details,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
        req: req
    });
});
