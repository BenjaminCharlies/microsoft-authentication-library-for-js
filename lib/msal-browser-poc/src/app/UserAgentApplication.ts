/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as msalAuth from "msal-common";

// Configuration
import { Configuration, buildConfiguration } from "./Configuration";

// Network
import { IXhrClient } from "../network/IXHRClient";
import { XhrClient } from "../network/XHRClient";

// Cache
import { BrowserStorage } from "../cache/BrowserStorage";

// Errors
import { ClientBrowserConfigurationError } from "../error/ClientBrowserConfigurationError";

// Utils
import { StringUtils } from "../utils/StringUtils";
import { WindowUtils } from "../utils/WindowUtils";

/**
 * Interface to handle iFrame generation, Popup Window creation and redirect handling
 */
declare global {
    interface Window {
        openedWindows: Array<Window>;
    }
}

/**
 * A type alias for an authResponseCallback function.
 * {@link (authResponseCallback:type)}
 * @param authErr error created for failure cases
 * @param response response containing token strings in success cases, or just state value in error cases
 */
export type authCallback = (authErr: msalAuth.AuthError, response?: msalAuth.AuthResponse) => void;

/**
 * Key-Value type to support queryParams, extraQueryParams and claims
 */
export type StringDict = {[key: string]: string};

/**
 * UserAgentApplication class
 *
 * Object Instance that the developer can use to make loginXX OR acquireTokenXX functions
 */
export class UserAgentApplication {

    // input configuration by the developer/user
    private config: Configuration;

    // auth functions imported from msal-common package
    private authModule: msalAuth.ImplicitAuthModule;
    
    // callback for error/token response
    private authCallback: authCallback = null;
    
    // App State Fields
    private redirectCallbacksSet: boolean;
    private interactionInProgress: boolean;

    // Cache manager
    private cacheStorage: BrowserStorage;

    // Network Client
    private networkClient: IXhrClient;

    /**
     * @constructor
     * Constructor for the UserAgentApplication used to instantiate the UserAgentApplication object
     *
     * Important attributes in the Configuration object for auth are:
     * - clientID: the application ID of your application.
     * You can obtain one by registering your application with our Application registration portal : https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredAppsPreview
     * - authority: the authority URL for your application.
     *
     * In Azure AD, authority is a URL indicating the Azure active directory that MSAL uses to obtain tokens.
     * It is of the form https://login.microsoftonline.com/&lt;Enter_the_Tenant_Info_Here&gt;.
     * If your application supports Accounts in one organizational directory, replace "Enter_the_Tenant_Info_Here" value with the Tenant Id or Tenant name (for example, contoso.microsoft.com).
     * If your application supports Accounts in any organizational directory, replace "Enter_the_Tenant_Info_Here" value with organizations.
     * If your application supports Accounts in any organizational directory and personal Microsoft accounts, replace "Enter_the_Tenant_Info_Here" value with common.
     * To restrict support to Personal Microsoft accounts only, replace "Enter_the_Tenant_Info_Here" value with consumers.
     *
     *
     * In Azure B2C, authority is of the form https://&lt;instance&gt;/tfp/&lt;tenant&gt;/&lt;policyName&gt;/
     *
     * @param {@link (Configuration:type)} configuration object for the MSAL UserAgentApplication instance
     */
    constructor(configuration: Configuration) {
        // Set the configuration
        this.config = buildConfiguration(configuration);

        // Create browser storage
        this.cacheStorage = new BrowserStorage(this.config.auth.clientId, this.config.cache);

        // Initialize the network module
        this.networkClient = new XhrClient();

        // Create the auth module
        this.authModule = new msalAuth.ImplicitAuthModule({ 
            auth: this.config.auth,
            storageInterface: this.cacheStorage,
            networkInterface: {
                sendRequestAsync: this.networkClient.sendRequestAsync
            }
        } as msalAuth.MsalConfiguration);

        // Set initial state vars
        this.redirectCallbacksSet = false;
        this.interactionInProgress = false;

        // Detect hash
        this.detectHashInResponse();
    }

    // #region Redirect Flow
    /**
     * @hidden
     * @ignore
     * Set the callback functions for the redirect flow to send back the success or error object.
     * @param {@link (tokenReceivedCallback:type)} authCallback - Callback which contains
     * an AuthError object, containing error data from either the server
     * or the library, depending on the origin of the error, or the AuthResponse object 
     * containing data from the server (returned with a null or non-blocking error).
     */
    handleRedirectCallback(authCallback: authCallback): void {
        if (!authCallback) {
            this.redirectCallbacksSet = false;
            throw ClientBrowserConfigurationError.createInvalidCallbackObjectError(authCallback);
        }
        
        this.authCallback = authCallback;
        this.redirectCallbacksSet = true;

        // On the server 302 - Redirect, handle this
        if (!this.config.framework.isAngular) {
            const cachedHash = this.cacheStorage.getItem(msalAuth.TemporaryCacheKeys.URL_HASH);
            if (cachedHash) {
                this.processCallback(cachedHash);
            }
        }
    }

    async loginRedirect(request: msalAuth.AuthenticationParameters) {
        // Throw error if callbacks are not set before redirect
        if (!this.redirectCallbacksSet) {
            throw ClientBrowserConfigurationError.createRedirectCallbacksNotSetError();
        }

        // Check if interaction is in progress
        if (this.interactionInProgress) {
            const thrownError = msalAuth.ClientAuthError.createLoginInProgressError();
            const stateOnlyResponse = msalAuth.buildResponseStateOnly(this.parseResponseState(request && request.state));
            this.authCallback(thrownError, stateOnlyResponse);
            return;
        }
        let urlNavigate;
        try {
            urlNavigate = await this.authModule.createLoginUrl(request || {});
            this.navigateWindow(urlNavigate);
        } catch(e) {
            const stateOnlyResponse = msalAuth.buildResponseStateOnly(this.parseResponseState(request && request.state));
            this.authCallback(e, stateOnlyResponse);
        }
    }

    private parseResponseState(state: string) {
        if (state) {
            const splitIndex = state.indexOf("|");
            if (splitIndex > -1 && splitIndex + 1 < state.length) {
                return state.substring(splitIndex + 1);
            }
        }
        return state;
    }

    private navigateWindow(urlNavigate: string) {
        // Navigate if valid URL
        if (urlNavigate && !StringUtils.isEmpty(urlNavigate)) {
            const urlString = new msalAuth.UrlString(urlNavigate);
            urlString.validateAsUri();
            window.location.replace(urlNavigate);
        } else {
            throw msalAuth.AuthError.createUnexpectedError("Navigate url is empty");
        }
    }

    private detectHashInResponse() {
        const urlHash = window.location.hash;
        const urlIsKnownHash = msalAuth.UrlString.hashContainsKnownProperties(urlHash);

        if (!this.config.framework.isAngular && urlIsKnownHash && !WindowUtils.isInIframe() && !WindowUtils.isInPopup()) {
            this.handleAuthenticationResponse(urlHash);
        }
    }

    private handleAuthenticationResponse(urlHash: string) {
        // Retrieve the hash
        const locationHash = urlHash || window.location.hash;

        // TODO: Check if we are currently in popup or iframe

        // if navigateToLoginRequestUrl is set to true, msal will navigate before processing hash (only for redirect cases)
        if (this.config.auth.navigateToLoginRequestUrl) {
            // Set hash to cache
            this.cacheStorage.setItem(msalAuth.TemporaryCacheKeys.URL_HASH, locationHash);
            if (window.parent === window) {
                // Set window to url from cache
                window.location.replace(this.cacheStorage.getItem(msalAuth.TemporaryCacheKeys.ORIGIN_URI));
            }
            return;
        }
        else {
            window.location.hash = "";
        }

        if (!this.redirectCallbacksSet) {
            // We reached this point too early, return and processCallback in handleRedirectCallbacks
            // Set hash to cache
            this.cacheStorage.setItem(msalAuth.TemporaryCacheKeys.URL_HASH, locationHash);
            return;
        }

        this.processCallback(locationHash);

        // TODO: Close all open popups
    }

    private processCallback(hash: string) {
        let response: msalAuth.AuthResponse;
        let authErr: msalAuth.AuthError;
        const responseState = this.authModule.extractResponseState(hash);
        try {
            response = this.authModule.handleResponse(hash);
        } catch (err) {
            authErr = err;
        }

        this.cacheStorage.clearMsalCookie(responseState.state);

        if (authErr) {
            
            this.authCallback(authErr, msalAuth.buildResponseStateOnly(responseState.state));
        } else {
            this.authCallback(null, response);
        }
    }
}
