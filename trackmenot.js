/*******************************************************************************

    This file is part of TrackMeNot).

    TrackMeNot is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation,  version 2 of the License.

    TrackMeNot is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Foobar.  If not, see <http://www.gnu.org/licenses/>.
 ********************************************************************************/

/* ============================================================================
 * TrackMeNot – background search worker ("TMNSearch" engine).
 *
 * PURPOSE:
 *   TrackMeNot hides the user's real search queries inside a stream of
 *   automatically issued, randomly chosen decoy queries. This background
 *   script (a WebExtension background page) schedules those searches,
 *   picks random queries from several feeds, talks to the optional
 *   background tab that renders search pages, and persists all settings
 *   in browser.storage.local.
 *
 * LIFECYCLE (start-up):
 *   1. The IIFE below defines and immediately returns the public API object
 *      (all state is private inside the closure).
 *   2. At the bottom of the file the event listeners are registered.
 *   3. _getStorage() loads the persisted state and passes it to
 *      _restoreTMN(), which restores options/engines/queries, runs the
 *      one-time "30 searches per hour" migration, re-attaches to the
 *      surviving background tab and finally starts the search scheduler.
 * ==========================================================================*/

"use strict";

/* ----------------------------------------------------------------------------
 * Cross-browser API shim:
 * WebExtensions expose the global namespace as `browser` (Firefox) or
 * `chrome` (Chrome/Edge). This picks whichever is available so the rest of
 * the file can simply use `api.*`. (In Firefox a `chrome` shim also exists,
 * so the check is safe in both directions.)
 * -------------------------------------------------------------------------- */
var api;
if (typeof chrome === 'undefined') {
    api = browser;
} else {
    api = chrome;
}

/* Shorthand for the i18n message service (locale strings under /locale). */
var _ = api.i18n && api.i18n.getMessage ? api.i18n.getMessage : function (m) { return m; };

/* Global namespace object for the extension. */
if (!TRACKMENOT) var TRACKMENOT = {};

/* ============================================================================
 * TMNSearch – the background engine.
 * This function is an IIFE (note the closing `}()`): everything declared
 * inside is private; only the object in the final `return {...}` statement
 * is exposed as TRACKMENOT.TMNSearch.
 * ==========================================================================*/
TRACKMENOT.TMNSearch = function() {

    /* ------------------------------------------------------------------
     * Private state
     * ------------------------------------------------------------------ */

    /** ID of the hidden background tab used to render search result pages
     *  ("tab mode"). -1 means "no tab yet". */
    var tmn_tab_id = -1;

    /** Master switch for verbose debug output (see debug()). */
    var debug_ = false;

    /** Whether "incremental" follow-up queries should be generated from
     *  long decoy queries (sub-queries built from subsets of the words). */
    var useIncrementals = true;

    /** Queue of pending incremental sub-queries waiting to be sent. */
    var incQueries = [];

    /** Currently selected search engine id ('google', 'yahoo', 'bing', ...). */
    var engine = 'google';

    /** The user-configured search engines (list of engine descriptors). */
    var tmn_engines = {};

    /** Pool of queries per feed type: zeitgeist / rss / extracted / dhs. */
    var TMNQueries = {};

    /** Hard-coded "zeitgeist" query pool: popular-but-harmless terms that
     *  statistically resemble real user interest and are used when no RSS
     *  feeds are available. */
    var zeit_queries = ["facebook", "youtube", "myspace", "craigslist", "ebay", "yahoo", "walmart", "netflix", "amazon", "home depot", "best buy", "Kentucky Derby", "NCIS", "Offshore Drilling", "H[...]"];

    /** In-memory activity log (entries are unshifted here and mirrored to
     *  storage key "logs_tmn" for display on the options page). */
    var tmnLogs = [];

    /** Engine used for the previous search (needed to simulate a result
     *  click on that engine). */
    var prev_engine = null;

    /** Engine the current "burst" is running against (see enterBurst). */
    var burstEngine = '';

    /** Interval (ms) between two searches while a burst is active. */
    var burstTimeout = 6000;

    /** Remaining number of searches in the current burst. */
    var burstCount = 0;

    /** All user options; populated by setDefaultOptions() and overlaid with
     *  the persisted "options_tmn" object (see restoreOptions). */
    var tmn_options = {};

    /** Request payload sent to the background tab in tab mode
     *  (query, engine, url map, mode, search id). */
    var TMNReq = {};

    /** Last known engine-id → url map (learned from real search URLs). */
    var currentUrlMap = {};

    /** setTimeout handle of the timer that will trigger the next search. */
    var tmn_searchTimer = null;

    /** Id of the last logged query entry (used to suppress duplicates). */
    var tmn_logged_id = 0;

    /** Current scheduling mode: 'timed' (normal), 'burst' (after a real
     *  user search) or 'recovery' (after an error). */
    var tmn_mode = 'timed';

    /** Watchdog timer: if no page loads within 3x the scheduled delay,
     *  rescheduleOnError() fires and switches to recovery mode. */
    var tmn_errTimeout = null;

    /** Guards against scheduling the next search twice. */
    var tmn_scheduledSearch = false;

    /** Whether the last search actually finished loading. */
    var tmn_hasloaded = false;

    /** The last fully built search URL (used for logging/clicks). */
    var currentTMNURL = '';

    /* ------------------------------------------------------------------
     * Exclusion patterns for generated queries.
     * ------------------------------------------------------------------ */
    var skipex = new Array(
        /calendar/i, /advanced/i, /click /i, /terms/i, /Groups/i,
        /Images/, /Maps/, /search/i, /cache/i, /similar/i, /&#169;/,
        /sign in/i, /help[^Ss]/i, /download/i, /print/i, /Books/i, /rss/i,
        /google/i, /bing/i, /yahoo/i, /aol/i, /html/i, /ask/i, /xRank/,
        /permalink/i, /aggregator/i, /trackback/, /comment/i, /More/,
        /business solutions/i, /result/i, / view /i, /Legal/, /See all/,
        /links/i, /submit/i, /Sites/i, / click/i, /Blogs/, /See your mess/,
        /feedback/i, /sponsored/i, /preferences/i, /privacy/i, /News/,
        /Finance/, /Reader/, /Documents/, /windows live/i, /tell us/i,
        /shopping/i, /Photos/, /Video/, /Scholar/, /AOL/, /advertis/i,
        /Webmasters/, /MapQuest/, /Movies/, /Music/, /Yellow Pages/,
        /jobs/i, /answers/i, /options/i, /customize/i, /settings/i,
        /Developers/, /cashback/, /Health/, /Products/, /QnABeta/,
        /<more>/, /Travel/, /Personals/, /Local/, /Trademarks/,
        /cache/i, /similar/i, /login/i, /mail/i, /feed/i
    );

    /* ------------------------------------------------------------------
     * Small generic helpers
     * ------------------------------------------------------------------ */

    /**
     * Removes all newline characters from a string.
     */
    function trim(s) {
        return s.replace(/\n/g, '');
    }

    /**
     * Logs an error message, optionally with an exception object.
     */
    function cerr(msg, e) {
        var txt = "[ERROR] " + msg;
        if (e) {
            txt += "\n" + e;
            if (e.message) txt += " | " + e.message;
        } else txt += " / No Exception";
        cout(txt);
    }

    /**
     * Basic console output. All non-debug information flows through here.
     */
    function cout(msg) {
        console.log(msg);
    }

    /**
     * Debug output; only printed when the debug_ flag above is true.
     */
    function debug(msg) {
        if (debug_)
            console.log("DEBUG: " + msg);
    }

    /**
     * Secure RNG helpers (use WebCryptoRandom when available, fallback to Math.random).
     */
    function secureRandomFloat() {
        if (window.WebCryptoRandom && typeof window.WebCryptoRandom.randomFloat === 'function') {
            return window.WebCryptoRandom.randomFloat();
        }
        return Math.random();
    }
    function secureRandInt(min, max) {
        if (window.WebCryptoRandom && typeof window.WebCryptoRandom.randInt === 'function') {
            return window.WebCryptoRandom.randInt(min, max);
        }
        // fallback
        return Math.floor(secureRandomFloat() * (max - min + 1)) + min;
    }

    /**
     * Returns a uniformly distributed integer in [min, max].
     * Uses CSPRNG helper when available.
     */
    function roll(min, max) {
        return secureRandInt(min, max);
    }

    /**
     * Returns a uniformly random element of an array.
     */
    function randomElt(array) {
        debug("Array length: " + array.length);
        var index = secureRandInt(0, array.length - 1);
        return array[index];
    }

    /* ==================================================================
     * Engine functions
     * ================================================================== */

    function getElementsByAttrValue(dom, nodeType, attrName, nodeValue) {
        var outlines = dom.getElementsByTagName(nodeType);
        for (var i = 0; i < outlines.length; i++) {
            if (outlines[i].hasAttribute(attrName) && outlines[i].getAttribute(attrName) === nodeValue)
                return outlines[i];
        }
        return null;
    }

    var default_engines = {"list":[
        {
            id: 'google',
            name: 'Google Search',
            urlmap: "https://www.google.com/search?hl=en&q=|",
            enabled: true,
            regexmap: "^(https?:\/\/[a-z]+\.google\.(co\\.|com\\.)?[a-z]{2,3}\/(search){1}[\?]?.*?[&\?]{1}q=)([^&]*)(.*)$"
        },
        {
            id: 'yahoo',
            name: 'Yahoo! Search',
            urlmap: "http://search.yahoo.com/search;_ylt=" + (function(){var id="A0geu"; while(id.length<24){var lower=Math.random()<.5;var num=parseInt(Math.random()*38); if(num===37){id+='_';continue;} if(num===36){id+='.';continue;} if(num<10){id+=String.fromCharCode(num+48);continue;} num+= lower?87:55; id+=String.fromCharCode(num);} return id;})() + "?ei=UTF-8&fr=sfp&fr2=sfp&p=|&fspl=1",
            enabled: true,
            regexmap: "^(https?:\/\/[a-z.]*?search\.yahoo\.com\/search.*?p=)([^&]*)(.*)$",
            host: "([a-z.]*?search\.yahoo\.com)$"
        },
        {
            id: 'bing',
            name: 'Bing Search',
            urlmap: "http://www.bing.com/search?q=|",
            enabled: true,
            regexmap: "^(https?:\/\/www\.bing\.com\/search\?[^&]*q=)([^&]*)(.*)$",
            host: "(www\.bing\.com)$"
        },
        {
            id: 'baidu',
            name: 'Baidu Search',
            urlmap: "http://www.baidu.com/s?wd=|",
            enabled: false,
            regexmap: "^(https?:\/\/www\.baidu\.com\/s\?.*?wd=)([^&]*)(.*)$",
            host: "(www\.baidu\.com)$"
        },
        {
            id: 'aol',
            name: 'Aol Search',
            urlmap: "http://search.aol.com/aol/search?q=|",
            enabled: false,
            regexmap: "^(https?:\/\/[a-z0-9.]*?search\.aol\.com\/aol\/search\?.*?q=)([^&]*)(.*)$",
            host: "([a-z0-9.]*?search\.aol\.com)$"
        }
    ]}

    function getEngineById(id) {
        return tmn_engines.list.filter(function(a) {
            return a.id === id;
        })[0];
    }

    function chooseElt(arr) {
        return arr[Math.floor(secureRandomFloat() * arr.length)];
    }

    function getYahooId() {
        var id = "A0geu";
        while (id.length < 24) {
            var lower = Math.random() < .5;
            var num = parseInt(Math.random() * 38);
            if (num === 37) {
                id += '_';
                continue;
            }
            if (num === 36) {
                id += '.';
                continue;
            }
            if (num < 10) {
                id += String.fromCharCode(num + 48);
                continue;
            }
            num += lower ? 87 : 55;
            id += String.fromCharCode(num);
        }
        return id;
    }

    /* ==================================================================
     * Tab functions
     * ================================================================== */

    function changeTabStatus(useT) {
        if (useT === tmn_options.useTab) return;
        tmn_options.useTab = useT;
        if (useT) {
            createTab();
        } else {
            deleteTab();
        }
    }

    function getTMNTab() {
        debug("Trying to access to the tab: " + tmn_tab_id);
        return tmn_tab_id;
    }

    function deleteTab() {
        if (tmn_tab_id === -1) return;
        else {
            api.storage.local.set({"tab_id": -1});
            api.tabs.remove(tmn_tab_id, function() {
                if (api.runtime && api.runtime.lastError) {
                    cout("Can't kill tab due to error : "  + (api.runtime.lastError && api.runtime.lastError.message));
                }
            });
        }
    }

    function createTab(pendingRequest) {
        if (tmn_tab_id !== -1) return;
        try {
            api.tabs.create({
                'active': false,
                'url': 'http://www.google.com',
                'pinned' : false
            }, function (e) {initTab(e, pendingRequest)});
        } catch (ex) {
            cerr('Can no create TMN tab:', ex);
        }
    }

    function initTab(tab, pendingRequest) {
        tmn_tab_id = tab.id;
        api.storage.local.set({"tab_id": tmn_tab_id});
        cout("pending request: " + JSON.stringify(pendingRequest));
        if (pendingRequest !== null) {
            try {
                api.tabs.sendMessage(tmn_tab_id, pendingRequest);
                cout('Message sent to the tab: ' + tmn_tab_id + ' : ' + JSON.stringify(pendingRequest));
            } catch (e) {
                cout('Failed to deliver pending request to tab: ' + e);
            }
        }
    }

    function monitorBurst() {
        if (!api.webNavigation || !api.webNavigation.onCommitted) return;
        api.webNavigation.onCommitted.addListener(function(e) {
            var url = e.url;
            var tab_id = e.tabId;
            var result = checkForSearchUrl(url);
            if (!result) {
                if (tab_id === tmn_tab_id) {
                    debug("TMN tab trying to visit: " + url);
                }
                return;
            }

            //
            // -- EXTRACT DATA FROM THE URL
            // result = [fullMatch, prefix, query, suffix, engineId]
            var pre = result[1];
            var query = result[2];
            var post = result[3];
            var eng = result[4];
            var asearch = pre + '|' + post;
            if (tmn_tab_id === -1 || tab_id !== tmn_tab_id) {
                debug("Worker find a match for url: " + url + " on engine " + eng + "!");
                if (tmn_options.burstMode) enterBurst(eng);
                var engineObj = getEngineById(eng);
                if (engineObj && engineObj.urlmap !== asearch) {
                    engineObj.urlmap = asearch;
                    api.storage.local.set({'engines_tmn': tmn_engines});
                    var logEntry = createLog('URLmap', eng, null, null, null, asearch)
                    log(logEntry);
                    debug("Updated url fr search engine " + eng + ", new url is " + asearch);
                }
            }
        });

    }

    function checkForSearchUrl(url) {
        var result = null;
        var eng;
        for (var i = 0; i < tmn_engines.list.length; i++) {
            eng = tmn_engines.list[i];
            var regex = eng.regexmap;
            result = url.match(regex);
            if (result) {
                cout(regex + " MATCHED! on " + eng.id);
                break;
            }
        }
        if (!result) return null;

        if (result.length !== 4) {
            if (result.length === 6 && eng.id === "google") {
                result.splice(2, 2);
                result.push(eng.id);
                return result;
            }
            cerr("REGEX_ERROR: " + url);
            return null;
        }
        result.push(eng.id);
        return result;
    }

    function isBursting() {
        return (tmn_options.burstMode && (burstCount > 0));
    }

    /* ==================================================================
     * Query generation
     * ================================================================== */

    function randomQuery() {
        var typeoffeeds = Object.keys(TMNQueries);
        var qtype = randomElt(typeoffeeds);
        var queries = [];
        if (qtype !== 'zeitgeist' && qtype !== 'extracted') {
            var queryset = TMNQueries[qtype];
            queries = randomElt(queryset).words;
        } else queries = TMNQueries[qtype];
        var term = trim(randomElt(queries));
        if (!term || term.length < 1)
            throw new Error(" getQuery.term='" + term + "'");
        return term;
    }

    function validateFeeds(param) {
        TMNQueries.rss = [];
        tmn_options.feedList = param.feeds;
        var feeds = tmn_options.feedList;
        for (var i = 0; i < feeds.length; i++)
            doRssFetch(feeds[i]);
        saveOptions();
    }

    function extractQueries(html) {
        var forbiddenChar = new RegExp("^[ @#<>\"\\\/,;'?{}:?%|\^~`=]", "g");
        var splitRegExp = new RegExp('^[\\[\\]\\(\\)\\"\']', "g");

        if (!html) {
            cout("NO HTML!");
            return;
        }

        var phrases = new Array();
        var l = html.split(/((<\?tr>)|(<br>)|(<\/?p>))/i);
        for (var i = 0; i < l.length; i++) {
            if (!l[i] || l[i] == "undefined") continue;
            l[i] = l[i].replace(/(<([^>]+)>)/ig, " ");
            if (/([a-z]+ [a-z]+)/i.test(l[i])) {
                var reg = /([a-z]{4,} [a-z]{4,} [a-z]{4,} ([a-z]{4,} ?) {0,3})/i;
                var matches = reg.exec(l[i]);
                if (!matches || matches.length < 2) continue;
                var newQuery = trim(matches[1]);
                if (newQuery && phrases.indexOf(newQuery.toLowerCase()) < 0) {
                    phrases.push(newQuery.toLowerCase());
                    if (!TMNQueries.extracted) TMNQueries.extracted = [];
                    addQuery(newQuery, TMNQueries.extracted);
                }
            }
        }
    }

    function isBlackList(term) {
        if (!tmn_options.use_black_list) return false;
        var words = term.split(/\W/g);
        for (var i = 0; i < words.length; i++) {
            if (tmn_options.kwBlackList.indexOf(words[i].toLowerCase()) >= 0)
                return true;
        }
        return false;
    }

    function queryOk(a) {
        for (let i = 0; i < skipex.length; i++) {
            if (skipex[i].test(a))
                return false;
        }
        return true;
    }

    function addQuery(term, queryList) {
        var noniso = new RegExp("[^a-zA-Z0-9_.\ \\u00C0-\\u00FF+]+", "g");

        term = term.replace(noniso, '');
        term = trim(term);

        if (isBlackList(term))
            return false;

        if (!term || (term.length < 3) || (queryList.indexOf(term) > 0))
            return false;

        if (term.indexOf("\"\"") > -1 || term.indexOf("--") > -1)
            return false;

        // test for negation of a single term (eg '-prison')
        if (term.indexOf("-") === 0 && term.indexOf(" ") < 0)
            return false;

        if (!queryOk(term))
            return false;

        queryList.push(term);
        return true;
    }

    function filterKeyWords(rssTitles) {
        var addStr = ""; //tmp-debugging
        var forbiddenChar = new RegExp("[ @#<>\"\\\/,;'Õ{}:?%|\^~`=]+", "g");
        var splitRegExp = new RegExp('[\\[\\]\\(\\)\\"\']+', "g");
        var wordArray = rssTitles.split(forbiddenChar);

        for (var i = 0; i < wordArray.length; i++) {
            if (!wordArray[i].match('-----')) {
                var word = wordArray[i].split(splitRegExp)[0];
                if (word && word.length > 2) {
                    W: while (i < (wordArray.length) && wordArray[i + 1] && !(wordArray[i + 1].match('-----') ||
                            wordArray[i + 1].match(splitRegExp))) {
                        var nextWord = wordArray[i + 1];
                        if (nextWord !== nextWord.toLowerCase()) {
                            nextWord = trim(nextWord.toLowerCase().replace(/\s/g, '').replace(/[(<>"'Õ&]/g, ''));
                            if (nextWord.length > 1) {
                                word += ' ' + nextWord;
                            }
                        }
                        i++;
                    }
                    addStr += word.replace(/-----/g, '');
                }
            }
        }
        return addStr;
    }

    function addRssTitles(xmlData, feedUrl) {
        var rssTitles = "";

        if (!xmlData) return 0;

        var feedTitles = xmlData.getElementsByTagName("title");
        if (!feedTitles || feedTitles.length < 2) {
            cerr("no items(" + feedTitles + ") for rss-feed: " + feedUrl);
            return 0;
        }
        var feedObject = {};
        feedObject.name = feedTitles[0].firstChild.nodeValue;
        feedObject.words = [];
        cout('ADD RSS title : ' + feedTitles[0].firstChild.nodeValue);
        for (var i = 1; i < feedTitles.length; i++) {
            if (feedTitles[i].firstChild) {
                rssTitles = feedTitles[i].firstChild.nodeValue;
                rssTitles += " ----- ";
            }
            var queryToAdd = filterKeyWords(rssTitles);
            addQuery(queryToAdd, feedObject.words);
        }
        cout(feedObject.name + " : " + feedObject.words);
        TMNQueries.rss.push(feedObject);

        return 1;
    }

    function readDHSList() {
        TMNQueries.dhs = [];
        var i = 0;
        var req = new XMLHttpRequest();
        try {
            req.open('GET', "dhs_keywords.json", true);
            req.onreadystatechange = function() {
                if (req.readyState === 4) {
                    var keywords = JSON.parse(req.responseText).keywords;
                    for (var cat of keywords) {
                        TMNQueries.dhs[i] = {};
                        TMNQueries.dhs[i].category_name = cat.category_name;
                        TMNQueries.dhs[i].words = [];
                        for (var word of cat.category_words)
                            TMNQueries.dhs[i].words.push(word.name);
                        i++;
                    }
                    return;
                }
            }
            req.send();
        } catch (ex) {
            cout("[WARN]  Can not load DHS list: " + ex.message);
            return
        }
    }

    function doRssFetch(feedUrl) {
        if (!feedUrl) return;
        cout("Feed Url: " + feedUrl);
        var req = new XMLHttpRequest();
        try {
            req.open('GET', feedUrl, true);
            req.onreadystatechange = function() {
                if (req.readyState === 4) {
                    var doc = req.responseXML;
                    debug(doc);
                    addRssTitles(doc, feedUrl);
                }
            };
            req.send();
        } catch (ex) {
            cout("[WARN]  doRssFetch(" + feedUrl + ")\n" +
                "  " + ex.message + " | Using defaults...");
            return;
        }
    }

    function getSubQuery(queryWords) {
        var incQuery = "";
        var randomArray = new Array();
        for (var k = 0; k < queryWords.length; k++) {
            let randomIndex = roll(0, queryWords.length - 1);
            if (randomArray.indexOf(randomIndex) < 0)
                randomArray.push(randomIndex);
        }
        randomArray.sort();
        for (k = 0; k < randomArray.length - 1 && k < 5; k++) {
            incQuery += queryWords[randomArray[k]] + ' ';
        }
        incQuery += queryWords[randomArray[k]];
        if (incQueries)
            incQueries.push(trim(incQuery));
    }

    function getQuery() {
        var term = randomQuery();
        if (term.indexOf('\n') > 0) {
            while (true) {
                for (var i = 0; i < term.length; i++) {
                    if (term.charAt(i) === '\n') {
                        term = term.substring(0, i) + ' ' + term.substring(i + 1, term.length);
                        continue;
                    }
                }
                break;
            }
        }
        return term;
    }

    /* ==================================================================
     * Status badge (browser toolbar)
     * ================================================================== */

    function updateOnErr() {
        try {
            api.browserAction.setBadgeBackgroundColor({'color': [255, 0, 0, 255]});
            api.browserAction.setBadgeText({'text': 'Error'});
            api.browserAction.setTitle({'title': 'TMN Error'});
        } catch (ex){
            debug("browserAction are not supported on mobile")
        }
    }

    function updateOnSend(queryToSend) {
        try{
            api.browserAction.setBadgeBackgroundColor({'color': [113, 113, 198, 255]})
            api.browserAction.setBadgeText({'text': queryToSend});
            api.browserAction.setTitle({'title': engine + ': ' + queryToSend});
        } catch (ex){
            debug("browserAction are not supported on mobile")
        }
    }

    function createLog(type, engine, mode, query, id, asearch) {
        var logEntry = {};
        logEntry.type = type;
        logEntry.engine = engine;
        if (mode) logEntry.mode = tmn_mode;
        if (query) logEntry.query = query;
        if (id) logEntry.id = id;
        if (asearch) logEntry.newUrl = asearch;
        return logEntry;
    }

    /* ==================================================================
     * Search execution
     * ================================================================== */

    function doSearch() {
        var newquery = getQuery();

        // If incremental sub-queries are queued, they take priority and
        // are consumed one by one on subsequent timer ticks.
        if (incQueries && incQueries.length > 0)
            sendQuery(null);
        else {
            newquery = getQuery();
            let queryWords = newquery.split(' ');
            if (queryWords.length > 3) {
                getSubQuery(queryWords);
                if (useIncrementals) {
                    var unsatisfiedNumber = roll(1, 4);
                    for (var n = 0; n < unsatisfiedNumber - 1; n++)
                        getSubQuery(queryWords);
                }
                if (incQueries && incQueries.length > 0)
                    newquery = incQueries.pop();
            }
            sendQuery(newquery);
        }
    }

    function sendQuery(queryToSend) {
        tmn_scheduledSearch = false;
        var url_map = getEngineById(engine).urlmap;
        if (queryToSend === null) {
            if (incQueries && incQueries.length > 0)
                queryToSend = incQueries.pop();
            else {
                if (!queryToSend) cout('sendQuery error! queryToSendis null');
                return;
            }
        }
        // 90% of queries are lower-cased – mirrors real user behaviour.
        if (secureRandomFloat() < 0.9) queryToSend = queryToSend.toLowerCase();
        if (queryToSend[0] === ' ') queryToSend = queryToSend.substr(1); //remove the first space ;
        tmn_hasloaded = false;
        if (tmn_options.useTab) {
            // --- tab mode ---
            TMNReq = {};
            TMNReq.tmnQuery = queryToSend;
            TMNReq.tmnEngine = JSON.stringify(getEngineById(engine));
            TMNReq.tmnUrlMap = url_map;
            TMNReq.tmnMode = tmn_mode;
            TMNReq.tmnID = (tmn_options.tmn_id++);

            console.log(JSON.stringify(TMNReq));
            if (tmn_tab_id === -1) {
                createTab(TMNReq);
            } else {
                api.tabs.get(tmn_tab_id, function( tab) {
                    if (api.runtime && api.runtime.lastError) {
                        console.log(api.runtime.lastError.message);
                        tmn_tab_id = -1;
                        createTab(TMNReq);
                    } else {
                        api.tabs.sendMessage(tab.id, TMNReq);
                    }
                });
                cout('Message sent to the tab: ' + tmn_tab_id + ' : ' + JSON.stringify(TMNReq));
            }
        }
        else {
            // --- background mode ---
            var queryURL = queryToURL(url_map, queryToSend);
            api.cookies.getAll({'url': queryURL}, function(cookies) {sendBackgroundQuery( cookies, queryURL, queryToSend)} );
        }
    }

    function sendBackgroundQuery( cookies, queryURL, queryToSend) {
        var cookies_string = cookies && cookies.map ? cookies.map(function (x) {return x.name + "="+ x.value;}).join("; ") : '';
        cout("The encoded URL is " + queryURL)
        fetch(queryURL, {
            headers: {
                "cookie": cookies_string
            }
        }).then(function(response) {
            if (response.ok){
                clearTimeout(tmn_errTimeout);
                var logEntry = {
                    'type': 'query',
                    "engine": engine,
                    'mode': tmn_mode,
                    'query': queryToSend,
                    'id': tmn_options.tmn_id++
                };
                log(logEntry);
                tmn_hasloaded = true;
                reschedule();
            }
        }).catch(function(e){
            cout("[WARN] fetch error: " + e);
            rescheduleOnError();
        });
        updateOnSend(queryToSend);
        currentTMNURL = queryURL;
    }

    function queryToURL(url, query) {
        query = query.toLowerCase();
        var urlQuery = url.replace('|', query);
        urlQuery = urlQuery.replace(/ /g, '+');
        var encodedUrl = encodeURI(urlQuery);
        encodedUrl = encodedUrl.replace(/%253/g, "%3");

        return encodedUrl;
    }

    /* ==================================================================
     * Scheduling
     * ================================================================== */

    function rescheduleOnError() {
        var pauseAfterError = Math.max(2 * tmn_options.timeout, 120000);
        tmn_mode = 'recovery';
        burstCount = 0;
        cout("[INFO] Trying again in " + (pauseAfterError / 1000) + "s");
        log({
            'type': 'ERROR',
            'message': 'next search in ' + (pauseAfterError / 1000) + "s",
            'engine': engine
        });
        updateOnErr();

        if (tmn_options.enabled)
            scheduleNextSearch(pauseAfterError);
    }

    function reschedule() {
        var delay = tmn_options.timeout;

        if (tmn_scheduledSearch) return;
        tmn_scheduledSearch = true;

        if (isBursting()) { // schedule for burst
            delay = Math.min(delay, burstTimeout);
            scheduleNextSearch(delay);
            tmn_mode = 'burst';
            burstCount--;
        } else { // Not bursting, schedule per usual
            tmn_mode = 'timed';
            scheduleNextSearch(delay);
        }
    }

    function scheduleNextSearch(delay) {
        if (!tmn_options.enabled) return;

        var suggested = Number(delay) || Number(tmn_options.timeout) || 120000;

        var PRESET_RANGES = {
            low:    { min: 2 * 60 * 60 * 1000, mean: 6 * 60 * 60 * 1000, max: 24 * 60 * 60 * 1000 },
            medium: { min: 30 * 60 * 1000,     mean: 2 * 60 * 60 * 1000, max: 6 * 60 * 60 * 1000  },
            high:   { min: 15 * 1000,          mean: 60 * 1000,          max: 5 * 60 * 1000       }
        };

        var preset = tmn_options.activityPreset || 'medium';
        if (!(preset in PRESET_RANGES)) preset = 'medium';
        var range = PRESET_RANGES[preset];

        var mean = (suggested >= range.min && suggested <= range.max) ? suggested : range.mean;

        // Use WebCryptoRandom if available synchronously
        var sampled;
        if (window.WebCryptoRandom && typeof window.WebCryptoRandom.truncatedExponential === 'function' && typeof window.WebCryptoRandom.randomFloat === 'function') {
            sampled = Math.floor(window.WebCryptoRandom.truncatedExponential(mean, range.min, range.max));
            var jitter = Math.floor(sampled * (window.WebCryptoRandom.randomFloat() * 0.2 - 0.1));
            sampled = Math.max(1000, sampled + jitter);
        } else {
            // fallback
            sampled = Math.floor(Math.max(range.min, Math.min(range.max, mean)));
            var jitter2 = Math.floor(sampled * (Math.random() * 0.2 - 0.1));
            sampled = Math.max(1000, sampled + jitter2);
        }

        if (isBursting()) {
            sampled = Math.min(sampled, burstTimeout);
            tmn_mode = 'burst';
            burstCount--;
        } else {
            tmn_mode = 'timed';
        }

        prev_engine = engine;
        if (isBursting()) engine = burstEngine;
        else engine = chooseElt(tmn_engines.list.filter(function (x) { return x.enabled; })).id;

        debug('NextSearchScheduled on: ' + engine + ' in ' + sampled + 'ms (preset=' + preset + ')');

        window.clearTimeout(tmn_errTimeout);
        tmn_errTimeout = window.setTimeout(rescheduleOnError, sampled * 3);

        window.clearTimeout(tmn_searchTimer);
        tmn_searchTimer = window.setTimeout(doSearch, sampled);
    }

    function enterBurst(burst_engine) {
        if (!tmn_options.burstMode) return;
        cout("Entering burst mode for engine: " + burst_engine);
        var logMessage = {
            'type': 'info',
            'message': 'User made a search, start burst',
            'engine': burst_engine
        };
        log(logMessage);
        burstEngine = burst_engine;
        burstCount = roll(3, 10);
    }

    /* ==================================================================
     * Persistence & on/off control
     * ================================================================== */

    function saveOptions() {
        cout("Save option: " + JSON.stringify(tmn_options));

        try {
            api.storage.local.set({"options_tmn": tmn_options});
            api.storage.local.set({"engines_tmn": tmn_engines});
            api.storage.local.set({"gen_queries": TMNQueries});
        } catch (e) {
            cout("[WARN] saveOptions storage error: " + e);
        }
    }

    function stopTMN() {
        tmn_options.enabled = false;
        deleteTab();
        try {
            api.browserAction.setBadgeBackgroundColor({'color': [255, 0, 0, 255]});
            api.browserAction.setBadgeText({'text': 'Off'});
            api.browserAction.setTitle({'title': 'Off'});
        } catch (ex) {
            debug("browserAction are not supported on mobile")
        }
        window.clearTimeout(tmn_searchTimer);
        window.clearTimeout(tmn_errTimeout);
    }

    function formatNum(val) {
        if (val < 10) return '0' + val;
        return val;
    }

    function log(entry) {
        if (tmn_options.disableLogs) return;
        try {
            if (entry !== null) {
                if (entry.type === 'query') {
                    if (entry.id && entry.id === tmn_logged_id) return;
                    tmn_logged_id = entry.id;
                }
                var now = new Date();
                entry.date = formatNum(now.getHours()) + ":" + formatNum(now.getMinutes()) + ":" + formatNum(now.getSeconds()) +
                             '   ' + (now.getMonth() + 1) + '/' + now.getDate() + '/' + now.getFullYear();
            }
        } catch (ex) {
            cout("[ERROR] " + ex + " / " + ex.message + "\nlogging msg");
        }
        tmnLogs.unshift(entry);
        try {
            api.storage.local.set({"logs_tmn": tmnLogs});
        } catch (e) {
            cout("[WARN] unable to persist logs: " + e);
        }
    }

    function sendClickEvent() {
        if (!prev_engine) return;
        cout("Will send click event on: " + prev_engine);
        try {
            api.tabs.sendMessage(tmn_tab_id, {
                "click_eng": getEngineById(prev_engine)
            });
        } catch (ex) {
            cout(ex);
        }
    }

    function startTMN() {
        scheduleNextSearch(4000);
        monitorBurst();
        api.windows.onRemoved.addListener(function() {
            if (!tmn_options.saveLogs)
                api.storage.local.set({"logs_tmn": ""});
        });
    }

    function getTMNHTML() {
        var req = {}
        req.getTMNHTML = "gethtml";
        api.tabs.sendMessage(tmn_tab_id, req);
    }

    /* ==================================================================
     * Message hub
     * ================================================================== */
    function handleRequest(request, sender, sendResponse) {
        if (request.tmnLog) {
            cout("Background logging : " + request.tmnLog);
            try {
                var logtext = JSON.parse(request.tmnLog);
                log(logtext);
            } catch (e) {
                cout("Invalid log text delivered from content script: " + e);
            }
            sendResponse({});
            return;
        }
        if (request.updateStatus) {
            updateOnSend(request.updateStatus);
            sendResponse({});
            return;
        }
        if (request.getURLMap) {
            var engineId = request.getURLMap;
            var urlMap = currentUrlMap[engineId];
            sendResponse({"url": urlMap});
            return;
        }
        if (request.setURLMap) {
            cout("Background handling : " + request.setURLMap);
            var vars = request.setURLMap.split('--');
            var eng = vars[0];
            var asearch = vars[1];
            currentUrlMap[eng] = asearch;
            api.storage.local.set({"url_map_tmn": currentUrlMap});
            var logEntry = {};
            logEntry.type = 'URLmap';
            logEntry.engine = eng;
            logEntry.newUrl = asearch;
            TRACKMENOT.TMNSearch.log && TRACKMENOT.TMNSearch.log(logEntry);
            sendResponse({});
            return;
        }

        switch (request.tmn) {
            case "pageLoaded":
                if (!tmn_hasloaded) {
                    tmn_hasloaded = true;
                    clearTimeout(tmn_errTimeout);
                    reschedule();
                    if (tmn_options.sim_clicks && (secureRandomFloat() < 0.3) ) {
                        var time = roll(10, 1000);
                        window.setTimeout(sendClickEvent, time);
                    } else {
                        window.setTimeout(getTMNHTML, 1000);
                    }
                }
                sendResponse({});
                break;
            case "setHTML":
                extractQueries(request.html);
                break;
            case "tmnError":
                clearTimeout(tmn_errTimeout);
                rescheduleOnError();
                sendResponse({});
                break;
            case "TMNValideFeeds":
                validateFeeds(request.param);
                break;
            default:
                sendResponse({});
                return;
        }

    }

    /* ==================================================================
     * Options handling
     * ================================================================== */

    function setDefaultOptions() {
        tmn_options.enabled = true;
        tmn_options.timeout = 120000;
        tmn_options.timeoutMigrated30ph = false;
        tmn_options.burstMode = true;
        tmn_options.useTab = false;
        tmn_options.use_black_list = true;
        tmn_options.sim_clicks = false;
        tmn_options.use_dhs_list = false;
        tmn_options.kwBlackList = ['bomb', 'porn', 'pornographie'];
        tmn_options.saveLogs = true;
        tmn_options.feedList = ['http://www.techmeme.com/index.xml','http://rss.slashdot.org/Slashdot/slashdot','http://feeds.nytimes.com/nyt/rss/HomePage'];
        tmn_options.disableLogs = false;
        tmn_options.tmn_id = 0;

        tmn_options.activityPreset = tmn_options.activityPreset || 'medium';
    }

    function initQueries() {
        TMNQueries = {};
        TMNQueries.zeitgeist = zeit_queries;

        TMNQueries.rss = [];
        let feeds = tmn_options.feedList || [];
        feeds.forEach(doRssFetch);

        if (tmn_options.use_dhs_list ) {
            readDHSList();
        }
    }

    function onError(error) {
      console.log(`Error: ${error}`);
    }

    function getStorage(keys, callback) {
        try {
            let gettingItem = api.storage.local.get(keys);
            gettingItem.then(callback, onError);
        } catch (ex) {
            chrome.storage.local.get(keys, callback);
        }
    }

    function setDefaultEngines() {
        tmn_engines = default_engines;
    }

    function restoreOptions (items) {
        for (var key in items) {
            tmn_options[key] = items[key];
        }
        debug("Restore: " + tmn_options.enabled);

        if (tmn_options.feedList) {
            initQueries();
        }
        changeTabStatus(tmn_options.useTab);

        try{
            if (tmn_options.enabled) {
                api.browserAction.setBadgeText({'text': 'ON'});
                api.browserAction.setTitle({'title': 'TMN is ON'});
            } else {
                api.browserAction.setBadgeText({'text': 'OFF'});
                api.browserAction.setTitle({'title': 'TMN is OFF'});
            }
        } catch (ex) {
            debug("browserAction are not supported on mobile")
        }
    }

    function updateOptions (item) {

        if ( tmn_options.feedList !== item.feedList  ){
            tmn_options.feedList = item.feedList ;
            if (tmn_options.feedList) {
                initQueries();
            }
        }

        if ( tmn_options.enabled !== item.enabled  ){
            tmn_options.enabled = item.enabled;
            if (tmn_options.enabled)  startTMN();
            else stopTMN();
        }

        changeTabStatus(item.useTab);
        try {
            if (item.enabled) {
                api.browserAction.setBadgeText({'text': 'ON'});
                api.browserAction.setTitle({'title': 'TMN is ON'});
            } else {
                api.browserAction.setBadgeText({'text': 'OFF'});
                api.browserAction.setTitle({'title': 'TMN is OFF'});
            }
        } catch (ex) {
            debug("browserAction are not supported on mobile")
        }
        tmn_options = item;

    }

    function setEngines(item) {
        if(item) {
            tmn_engines = item;
        } else {
            tmn_engines = default_engines;
            api.storage.local.set({"engines_tmn": tmn_engines});
        }
    }

    function restoreQueries(item) {
        if (item) {
            TMNQueries = item;
        }
    }

    /* ==================================================================
     * Public API
     * ================================================================== */
    return {

        _handleRequest: function(request, sender, sendResponse) {
            handleRequest(request, sender, sendResponse);
        },

        _logStorageChange: function (items) {
            if ('options_tmn' in items)
                updateOptions(items.options_tmn.newValue);
            if ('engines_tmn' in items)
                setEngines(items.engines_tmn.newValue);
        },

        _restoreTMN: function (items) {
            if (!items["engines_tmn"]) {
                setDefaultEngines();
            } else {
                restoreQueries(items["gen_queries"]);
                setEngines(items["engines_tmn"]);
            }

            setDefaultOptions();
            if (!items["options_tmn"]) {
                cout("Init: " + tmn_options.enabled);
            } else {
                restoreOptions(items["options_tmn"]);
            }

            if (!tmn_options.timeoutMigrated30ph) {
                tmn_options.timeout = 120000;
                tmn_options.timeoutMigrated30ph = true;
                cout("Migration: set search rate to 30/hour");
            }

            initQueries();

            if (!items["tab_url"]) {
                tmn_tab_id = -1;
            } else {
                api.tabs.query({'pinned':false, 'url': items["tab_url"]}, function(tabs) {
                    if (tabs.length !== 0 ) {
                        cout("Restoring tab " + tabs[0].id)
                        tmn_tab_id = tabs[0].id;
                    } else {
                        cout("creating new tab");
                    }
                })
            }

            // Safe tmnLogs restore (previous bug: attempted a function call on items)
            try {
                tmnLogs = (items && items["logs_tmn"] && Array.isArray(items["logs_tmn"])) ? items["logs_tmn"] : [];
            } catch (ex) {
                tmnLogs = [];
                cout("can not restore logs");
            }
            saveOptions();
            startTMN();

        },

        _getEngine: function() {
            return engine;
        },

        _getQueries: function() {
            return TMNQueries;
        },

        _getStorage: function(keys, callback) {
            getStorage(keys, callback);
         },

        _resetSettings: function () {
            setDefaultEngines();
            setDefaultOptions();
            initQueries();

            // Reset logs to empty array when resetting settings
            tmnLogs = [];
            saveOptions();

        },

        _preserveTMNTab: function(tab_id) {
            if (tmn_tab_id === tab_id) {
                tmn_tab_id = -1;
                api.storage.local.set({"tab_id": tmn_tab_id});
                cout('TMN tab has been deleted by the user, reload it');
                return;
            }
        },

        _onUpdatedTab : function ( tabId) {
            if ( tabId === tmn_tab_id){
                if (!tmn_hasloaded) {
                    tmn_hasloaded = true;
                    clearTimeout(tmn_errTimeout);
                    reschedule();
                    api.tabs.get(tabId, function(tab) {
                        api.storage.local.set({"tab_url": tab.url});
                    });
                    if (tmn_options.sim_clicks && (secureRandomFloat() < 0.3) ) {
                        var time = roll(10, 1000);
                        window.setTimeout(sendClickEvent, time);
                    } else {
                        window.setTimeout(getTMNHTML, 1000);
                    }
                }
            }
        },

        _deleteOpenedTab : function (tab) {
            if ( tab.openerTabId === tmn_tab_id)
                api.tabs.remove(tmn_tab_id, function() {
                    if (api.runtime && api.runtime.lastError) {
                        cout("Can't kill tab due to error : " + (api.runtime.lastError && api.runtime.lastError.message));
                    }
                });
        },

        _deleteTMNTab : function() {
            api.tabs.remove(tmn_tab_id);
        }

    }

}();

/* ============================================================================
 * Event wiring & boot
 * ==========================================================================*/

api.runtime.onMessage.addListener(TRACKMENOT.TMNSearch._handleRequest);

api.tabs.onCreated.addListener(function(created_tab) {
        TRACKMENOT.TMNSearch._deleteOpenedTab(created_tab);
});

api.tabs.onUpdated.addListener(function(updated_tab_id) {
        TRACKMENOT.TMNSearch._onUpdatedTab(updated_tab_id);
});

api.windows.onRemoved.addListener(TRACKMENOT.TMNSearch._deleteTMNTab);

api.tabs.onRemoved.addListener(TRACKMENOT.TMNSearch._preserveTMNTab);

TRACKMENOT.TMNSearch._getStorage(
    ["options_tmn","gen_queries","engines_tmn","logs_tmn","tab_id","tab_url"],
    TRACKMENOT.TMNSearch._restoreTMN
);

api.storage.onChanged.addListener(TRACKMENOT.TMNSearch._logStorageChange);
