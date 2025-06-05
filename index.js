const express = require('express');
const session = require('express-session');
const { ExpressOIDC } = require('@okta/oidc-middleware');
const passport = require('passport');
const { CryptoProvider } = require('@azure/msal-node');
const app = express();
const port = process.env.PORT || 3000;
const SamlStrategy = require('@node-saml/passport-saml').Strategy;

app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.EXPRESS_SECRET,
  resave: false,
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

// Initialize Passport
app.use(passport.initialize());

const cryptoProvider = new CryptoProvider();

// --- SAML Configuration ---
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${port}`;
const AZURE_CALLBACK_PATH = '/auth/azure/callback'; // This is the path for the ACS URL
const AZURE_ACS_URL = APP_BASE_URL + AZURE_CALLBACK_PATH;

const SP_ENTITY_ID = process.env.SP_ENTITY_ID;

const AZURE_SAML_IDP_SSO_URL = process.env.AZURE_SAML_IDP_SSO_URL || `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/saml2`;

if (!process.env.AZURE_SAML_IDP_CERT) {
  throw new Error("FATAL ERROR: Missing required environment variable: AZURE_SAML_IDP_CERT. This is the IdP's signing certificate (PEM format).");
}
if (!AZURE_SAML_IDP_SSO_URL.includes('login.microsoftonline.com') && !process.env.AZURE_SAML_IDP_SSO_URL) {
    throw new Error("FATAL ERROR: Missing or invalid Azure SAML SSO URL. Check AZURE_SAML_IDP_SSO_URL or AZURE_TENANT_ID environment variables.");
}
if (!SP_ENTITY_ID.includes('/saml/metadata') && !process.env.SP_ENTITY_ID) {
    throw new Error("FATAL ERROR: Missing or invalid Service Provider Entity ID. Check SP_ENTITY_ID or APP_BASE_URL environment variables.");
}

const idpCert = process.env.AZURE_SAML_IDP_CERT.replace(/\\n/g, '\n');

const samlStrategy = new SamlStrategy(
  {
    entryPoint: AZURE_SAML_IDP_SSO_URL,
    issuer: SP_ENTITY_ID,
    callbackUrl: AZURE_ACS_URL,
    idpCert: idpCert,
    audience: SP_ENTITY_ID,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',    
    validateInResponseTo: 'ifPresent',
    passReqToCallback: true,
  },
  (req, profile, done) => {
    try {
      const rawAssertion = profile.getAssertionXml();
      if (!rawAssertion) {
        console.error("SAML Verify Callback: Raw SAML assertion XML not found in profile.");
        return done(new Error("SAML assertion XML not found in profile from IdP."));
      }
      return done(null, { samlAttributes: profile, rawSamlAssertion: rawAssertion });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] SAML Verify Callback Error:`, err);
      return done(err);
    }
  }
);
passport.use('saml', samlStrategy);

app.get('/', (req, res) => {
  res.send(`
    <h1>Hello World!</h1>
    <p>This is the public home page.</p>
    <a href="/login">Login with Initial IDP</a>
  `);
});

app.get('/profile', (req, res) => {
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

app.post('/search', async (req, res, next) => {
    const searchQuery = req.body.query;
    if (!searchQuery) {
        return res.status(400).send("Search query is missing.");
    }

    req.session.searchQuery = searchQuery;
    req.session.samlAuthState = cryptoProvider.createNewGuid();

    req.session.save(err => {
      if (err) {
          console.error("Session save error:", err);
          return next(err);
      }

      console.log(`[${new Date().toISOString()}] Session saved. Session ID: ${req.sessionID}, Stored samlAuthState (RelayState): "${req.session.samlAuthState}"`);

      const authOptions = {
          RelayState: req.session.samlAuthState
      };

      passport.authenticate('saml', authOptions)(req, res, next);
  });
});

// It's the Assertion Consumer Service (ACS) URL.
app.post('/auth/azure/callback',
    (req, res, next) => {
        passport.authenticate('saml', { session: false, failureRedirect: '/profile' },
            async (err, user, info) => { 
                if (err) {
                    console.error("SAML Authentication Strategy Error:", err);
                    if (info && info.message) console.error("SAML Strategy Info/Message:", info.message);
                    return next(err);
                }
                if (!user) {
                    return res.status(401).send("SAML authentication failed. No user object returned from strategy." + (info && info.message ? ` Reason: ${info.message}` : ''));
                }

                const searchQuery = req.session.searchQuery;
                const samlAssertion = user.rawSamlAssertion;                

                // Clean up session state
                delete req.session.samlAuthState;
                delete req.session.searchQuery;

                if (!searchQuery) {
                    return res.status(400).send("Search query not found in session. Please try searching again.");
                }
                if (!samlAssertion) {
                    console.error("SAML assertion is missing after successful authentication.");
                    return res.status(500).send("Critical error: SAML assertion not available.");
                }

                try {
                    const stsTokenResponse = await fetch('https://sts.googleapis.com/v1/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                            audience: process.env.GOOGLE_WIF_AUDIENCE,
                            scope: 'https://www.googleapis.com/auth/cloud-platform',
                            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
                            subject_token_type: 'urn:ietf:params:oauth:token-type:saml2',
                            subject_token: Buffer.from(samlAssertion).toString('base64'),
                        })
                    });

                    if (!stsTokenResponse.ok) {
                        const errorBody = await stsTokenResponse.text();
                        console.error("Google STS Token Exchange Error Body:", errorBody);
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

                    // Display results
                    res.send(`
                        <h1>Search Results</h1>
                        <h2>Query: ${searchQuery}</h2>
                        <h3>Azure AD SAML Assertion:</h3>
                        <textarea rows="20" cols="200" style="border:none;">${samlAssertion ? samlAssertion : 'N/A'}</textarea>
                        <h3>Google Cloud Access Token):</h3>
                        ${googleToken ? googleToken : 'N/A'}
                        <h3>Discovery Engine Results:</h3>
                        <pre>${JSON.stringify(searchResults, null, 2)}</pre>
                        <hr>
                        <h2>Search Again</h2>
                        <form action="/search" method="post">
                          <input type="text" name="query" placeholder="Enter your search query" required>
                          <button type="submit">Search</button>
                        </form>
                        <p><a href="/profile">Back to Profile</a></p>
                    `);

                } catch (error) {
                    console.error("Error in SAML callback processing or search execution:", error);
                     res.status(500).send(`
                        <h1>Error During Search Processing</h1>
                        <p>An error occurred after SAML authentication while trying to process your search.</p>
                        <p>Details: ${error.message}</p>
                        <pre>${error.stack ? error.stack : JSON.stringify(error, null, 2)}</pre>
                        <p><a href="/profile">Back to Profile</a></p>
                    `);
                }
            }
        )(req, res, next);
    }
);

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

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send(`
        <h1>Something broke!</h1>
        <pre>${err.message}</pre>
    `);
});
