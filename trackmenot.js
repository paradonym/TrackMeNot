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
if (chrome == undefined) {
    api = browser;
} else {
    api = chrome;
}

/* Shorthand for the i18n message service (locale strings under /locale). */
var _ = api.i18n.getMessage;

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
    var zeit_queries = ["facebook", "youtube", "myspace", "craigslist", "ebay", "yahoo", "walmart", "netflix", "amazon", "home depot", "best buy", "Kentucky Derby", "NCIS", "Offshore Drilling", "Halle Berry", "iPad Cases", "Dorothy Provine", "Emeril", "Conan O'Brien", "Blackberry", "Free Comic Book Day", " American Idol", "Palm", "Montreal Canadiens", "George Clooney", "Crib Recall", "Auto Financing", "Katie Holmes", "Madea's Big Happy Family", "Old Navy Coupon", "Sandra Bullock", "Dancing With the Stars", "M.I.A.", "Matt Damon", "Santa Clara County", "Joey Lawrence", "Southwest Airlines", "Malcolm X", "Milwaukee Bucks", "Goldman Sachs", "Hugh Hefner", "Tito Ortiz", "David McLaughlin", "Box Jellyfish", "Amtrak", "Molly Ringwald", "Einstein Horse", "Oil Spill", " Bret Michaels", "Mississippi Tornado", "Stephen Hawking", "Kelley Blue Book", "Hertz", "Mariah Carey", "Taiwan Earthquake", "Justin Bieber", "Public Bike Rental", "BlackBerry Pearl", "NFL Draft", "Jillian Michaels", "Face Transplant", "Dell", "Jack in the Box", "Rebbie Jackson", "Xbox", "Pampers", "William Shatner", "Earth Day", "American Idol", "Heather Locklear", "McAfee Anti-Virus", "PETA", "Rihanna", "South Park", "Tiger Woods", "Kate Gosselin", "Unemployment", "Dukan Diet", "Oil Rig Explosion", "Crystal Bowersox", "New 100 Dollar Bill", "Beastie Boys", "Melanie Griffith", "Borders", "Tara Reid", "7-Eleven", "Dorothy Height", "Volcanic Ash", "Space Shuttle Discovery", "Gang Starr", "Star Trek", "Michael Douglas", "NASCAR", "Isla Fisher", "Beef Recall", "Rolling Stone Magazine", "ACM Awards", "NASA Space Shuttle", "Boston Marathon", "Iraq", "Jennifer Aniston"];

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
    var currentUrlMap;

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
     * A candidate query that matches ANY of these regular expressions is
     * rejected by queryOk(). The patterns filter out navigation-ish and
     * boilerplate words that would look implausible as search terms.
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
     * Queries coming from RSS/HTML text must be single-line.
     */
    function trim(s) {
        return s.replace(/\n/g, '');
    }

    /**
     * Logs an error message, optionally with an exception object
     * (appends the exception text and its .message property).
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
     * Basic console output. All non-debug information flows through here,
     * so it would be the single place to redirect logging.
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
     * Returns a uniformly distributed integer in [min, max].
     * Used everywhere randomness is needed (delays, burst sizes, ...).
     */
    function roll(min, max) {
        return Math.floor(Math.random() * (max + 1)) + min;
    }

    /**
     * Returns a uniformly random element of an array.
     */
    function randomElt(array) {
        debug("Array length: " + array.length);
        var index = Math.floor(Math.random() * array.length)
        return array[index];
    }


    /* ==================================================================
     * Engine functions
     * ================================================================== */

    /**
     * Returns the first DOM element of the given node type whose attribute
     * matches the requested value (helper for scraping search result pages;
     * mostly used by the tab-mode content script).
     */
    function getElementsByAttrValue(dom, nodeType, attrName, nodeValue) {
        var outlines = dom.getElementsByTagName(nodeType);
        for (var i = 0; i < outlines.length; i++) {
            if (outlines[i].hasAttribute(attrName) && outlines[i].getAttribute(attrName) === nodeValue)
                return outlines[i];
        }
        return null;
    }

    /* ------------------------------------------------------------------
     * Built-in search engine descriptors.
     *  - urlmap:   URL template; the '|' placeholder is replaced with the
     *              (URL-encoded) query.
     *  - regexmap: matches real search URLs and splits them into
     *              [full, prefix, query, suffix] – used to detect searches
     *              and to re-learn the current URL scheme of an engine.
     *  - enabled:  whether the engine participates in the rotation by
     *              default (google/yahoo/bing on, baidu/aol off).
     * ------------------------------------------------------------------ */
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
            /* Note: getYahooId() is called here (at definition time!) and
             * generates ONE random tracking id per browser session. */
            urlmap: "http://search.yahoo.com/search;_ylt=" + getYahooId() + "?ei=UTF-8&fr=sfp&fr2=sfp&p=|&fspl=1",
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

    /**
     * Returns the engine descriptor with the given id from the currently
     * configured engine list, or undefined.
     */
    function getEngineById(id) {
        return tmn_engines.list.filter(function(a) {
            return a.id === id;
        })[0];
    }

    /**
     * Generates a random 24-character id used as Yahoo's ylt tracking
     * parameter. Mimics the format of a genuine Yahoo session id so the
     * automated searches look less suspicious.
     */
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
        //cout("GENERATED ID="+id);
        return id;
    }

    /**
     * Picks a random array element (alias of randomElt kept for
     * readability at call sites).
     */
    function chooseElt(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }


    /* ==================================================================
     * Tab functions
     * The decoy searches can run in a real (inactive) tab so that the
     * search engine's own JavaScript executes – this looks much more
     * authentic than a bare background request. tmn_tab_id tracks that tab.
     * ================================================================== */

    /**
     * Enables/disables tab mode at runtime. If the desired state differs
     * from the current one, the background tab is created or removed.
     */
    function changeTabStatus(useT) {
        if (useT === tmn_options.useTab) return;
        tmn_options.useTab = useT;
        if (useT) {
            createTab();
        } else {
            deleteTab();
        }
    }

    /**
     * Returns the id of the current background tab (or -1). Mainly a
     * debugging accessor.
     */
    function getTMNTab() {
        debug("Trying to access to the tab: " + tmn_tab_id);
        return tmn_tab_id;
    }

    /**
     * Closes the background tab (if any) and resets the persisted tab id
     * in storage so a restart does not try to re-attach to a dead tab.
     */
    function deleteTab() {
        if (tmn_tab_id === -1) return;
        else {
            api.storage.local.set({"tab_id": -1});
            api.tabs.remove(tmn_tab_id, function() {
                if (api.runtime.lastError) {
                    cout("Can't kill tab due to error : "  + api.runtime.lastError.message);
                }
            });
        }
    }

    /**
     * Opens a new inactive background tab (tab mode). If pendingRequest
     * is given it is forwarded to the tab as soon as it exists, so a
     * search that arrived before the tab was ready is not lost.
     */
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

    /**
     * Callback after tab creation: remembers the tab id, persists it and
     * delivers a queued search request to the new tab, if one exists.
     */
    function initTab(tab, pendingRequest) {
        tmn_tab_id = tab.id;
        api.storage.local.set({"tab_id": tmn_tab_id});
        cout("pending request: " + JSON.stringify(pendingRequest));
        if (pendingRequest !== null) {
            console.log(JSON.stringify(pendingRequest));
            api.tabs.sendMessage(tmn_tab_id, pendingRequest);
            cout('Message sent to the tab: ' + tmn_tab_id + ' : ' + pendingRequest);
        }
    }

    /**
     * Registers a webNavigation listener that watches EVERY navigation in
     * the browser. If the URL looks like a search on one of the configured
     * engines:
     *   - a burst is triggered (see enterBurst): the engine assumes the
     *     user just searched and fires several immediate decoy searches
     *     on the same engine to blend the real query into noise;
     *   - the engine's current URL scheme is re-learned (search engines
     *     change their parameter layout over time; the observed prefix and
     *     suffix around the query replace the stored urlmap).
     * Navigations of the TMN background tab itself are ignored.
     */
    function monitorBurst() {
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
                var engine = getEngineById(eng);
                if (engine && engine.urlmap !== asearch) {
                    engine.urlmap = asearch;
                    api.storage.local.set({'engines_tmn': tmn_engines});
                    var logEntry = createLog('URLmap', eng, null, null, null, asearch)
                    log(logEntry);
                    debug("Updated url fr search engine " + eng + ", new url is " + asearch);
                }
            }
        });

    }

    /**
     * Checks whether a given URL is a search-result URL of any configured
     * engine. Returns [match, prefix, query, suffix, engineId] (the query
     * is captured group 2 of the engine's regexmap) or null.
     * Google occasionally returns 6 capture groups; the extra two are
     * spliced out before the engine id is appended.
     */
    function checkForSearchUrl(url) {
        var result = null;
        var eng;
        for (var i = 0; i < tmn_engines.list.length; i++) {
            eng = tmn_engines.list[i];
            var regex = eng.regexmap;
            //debug("  regex: " + regex + "  ->\n                   " + url);
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
        }
        result.push(eng.id);
        return result;
    }

    /**
     * True while a burst is still in progress (burst mode enabled and
     * searches remaining).
     */
    function isBursting() {
        return (tmn_options.burstMode && (burstCount > 0));
    }

    /* ==================================================================
     * Query generation
     * ================================================================== */

    /**
     * Chooses a random query from the query pool:
     *  - 'zeitgeist' and 'extracted' pools are flat lists of strings;
     *  - every other feed type (e.g. rss) is a list of {name, words}
     *    objects, so a random feed object is chosen first.
     * Throws if the chosen pool unexpectedly yields an empty term.
     */
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

    /**
     * Replaces the configured RSS feed list with the new one (sent from
     * the options page), refetches all feeds and persists the options.
     */
    function validateFeeds(param) {
        TMNQueries.rss = [];
        tmn_options.feedList = param.feeds;
        var feeds = tmn_options.feedList;
        for (var i = 0; i < feeds.length; i++)
            doRssFetch(feeds[i]);
        saveOptions();
    }

    /**
     * Extracts plausible search phrases from the HTML of a rendered
     * search-results page (the page is fetched in tab mode via
     * getTMNHTML()). Long sequences of plain-text words become new
     * entries in the 'extracted' query pool. This is TrackMeNot's way of
     * refreshing its vocabulary with content that is currently "hot".
     */
    function extractQueries(html) {
        var forbiddenChar = new RegExp("^[ @#<>\"\\\/,;'?{}:?%|\^~`=]", "g");
        var splitRegExp = new RegExp('^[\\[\\]\\(\\)\\"\']', "g");

        if (!html) {
            cout("NO HTML!");
            return;
        }

        var phrases = new Array();
        // Parse the HTML into phrases
        // Split on row/paragraph boundaries, strip tags, then keep
        // stretches of at least three 4+-letter words as candidates.
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

        //cout(TMNQueries.extracted)
        //if (typeoffeeds.indexOf('extracted') == -1)
        //  typeoffeeds.push('extracted');
    }

    /**
     * True if any single word of the term is on the user's keyword
     * blacklist (used to keep embarrassing/unsafe terms out of the noise
     * stream – a query the user would never make looks suspicious).
     */
    function isBlackList(term) {
        if (!tmn_options.use_black_list) return false;
        var words = term.split(/\W/g);
        for (var i = 0; i < words.length; i++) {
            if (tmn_options.kwBlackList.indexOf(words[i].toLowerCase()) >= 0)
                return true;
        }
        return false;
    }

    /**
     * Applies the skipex exclusion patterns to a candidate query
     * (see the skipex definition above for details).
     */
    function queryOk(a) {
        for (let i = 0; i < skipex.length; i++) {
            if (skipex[i].test(a))
                return false;
        }
        return true;
    }

    /**
     * Validates a candidate term and, if acceptable, appends it to the
     * given query list. Rejected: blacklisted, too short (<3), already
     * present, containing '""' or '--', single-word negations ('-prison'),
     * and anything matching the skipex patterns. Non-ISO-8859 characters
     * are stripped first.
     */
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

    /**
     * Converts the concatenated titles of one RSS feed into a single
     * space-separated keyword string. Titles are separated by ' ----- '
     * markers (see addRssTitles); short glue words and markup characters
     * are removed, and words inside one title are joined with spaces.
     */
    // returns # of keywords added
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
                        var nextWord = wordArray[i + 1]; // added new check here -dch
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

    /**
     * Parses the XML document of one RSS feed, turns each <title> entry
     * into a candidate query (via filterKeyWords/addQuery) and appends a
     * {name, words} feed object to the rss query pool.
     * Returns 1 if the feed was processed, 0 on empty/broken feeds.
     */
    // returns # of keywords added
    function addRssTitles(xmlData, feedUrl) {
        var rssTitles = "";

        if (!xmlData) return 0; // only for asynchs? -dch

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

    /**
     * Loads the bundled dhs_keywords.json (a parody of a keyword watch
     * list) into the 'dhs' query pool. Only used when the corresponding
     * option is enabled. Fetch is asynchronous; the pool fills itself when
     * the response arrives.
     */
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

    /**
     * Fetches one RSS feed asynchronously and hands the parsed XML to
     * addRssTitles(). Failures are logged and silently ignored (defaults
     * are kept).
     */
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
            return; // no adds here...
        }
    }

    /**
     * Builds an "incremental" sub-query from a random subset (max ~5) of
     * the words of a long query and queues it in incQueries. Real users
     * often re-search with fewer/refined words; this imitates that.
     */
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

    /**
     * Returns one random query; newlines inside the term are replaced by
     * spaces (defensive cleanup of polluted feed data).
     */
    function getQuery() {
        var term = randomQuery();
        if (term.indexOf('\n') > 0) { // yuck, replace w' chomp();
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

    /**
     * Shows a red "Error" badge after a failed search. The try/catch
     * keeps mobile builds alive where browserAction is unavailable.
     */
    function updateOnErr() {
        try {
            api.browserAction.setBadgeBackgroundColor({'color': [255, 0, 0, 255]});
            api.browserAction.setBadgeText({'text': 'Error'});
            api.browserAction.setTitle({'title': 'TMN Error'});
        } catch (ex){
            debug("browserAction are not supported on mobile")
        }
    }

    /**
     * Shows the currently sent query in the toolbar badge (feedback for
     * the user that noise is being generated).
     */
    function updateOnSend(queryToSend) {
        try{
            api.browserAction.setBadgeBackgroundColor({'color': [113, 113, 198, 255]})
            api.browserAction.setBadgeText({'text': queryToSend});
            api.browserAction.setTitle({'title': engine + ': ' + queryToSend});
        } catch (ex){
            debug("browserAction are not supported on mobile")
        }
    }

    /**
     * Factory for a log entry object. Only requested fields are set;
     * mode is always taken from the global tmn_mode, not the parameter.
     */
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

    /**
     * Called by the scheduler timer: draws a new query, optionally
     * builds incremental sub-queries first (sent one per timer tick), and
     * dispatches the actual search via sendQuery().
     */
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
                // not sure what is going on here? -dch
                if (incQueries && incQueries.length > 0)
                    newquery = incQueries.pop();
            }
            sendQuery(newquery);
        }
    }

    /**
     * Sends one decoy query.
     *  - Tab mode: the request is forwarded to the background tab, whose
     *    content script navigates to the search URL (the engine's own JS
     *    runs; most realistic).
     *  - Background mode: fetch() is used directly, with the browser's
     *    cookies for the search domain attached so the request looks like
     *    it comes from the logged-in user.
     * queryToSend === null means "take the next queued sub-query".
     */
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
        if (Math.random() < 0.9) queryToSend = queryToSend.toLowerCase();
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
                // No tab yet: create one and hand the request over
                // as a "pending request" once it is ready.
                createTab(TMNReq);
            } else {
                api.tabs.get(tmn_tab_id, function( tab) {
                    if (api.runtime.lastError) {
                        // Tab died in the meantime – recreate it.
                        console.log(api.runtime.lastError.message);
                        tmn_tab_id = -1;
                        createTab(TMNReq);
                    } else {
                        api.tabs.sendMessage(tab.id, TMNReq);
                    }
                });
                cout('Message sent to the tab: ' + tmn_tab_id + ' : ' + TMNReq);
            }
        }
        else {
            // --- background mode ---
            var queryURL = queryToURL(url_map, queryToSend);
            api.cookies.getAll({'url': queryURL}, function(cookies) {sendBackgroundQuery( cookies, queryURL, queryToSend)} );
        }
    }

    /**
     * Performs the actual HTTP request in background mode. On success the
     * error watchdog is cleared, the query is logged and the next search
     * is scheduled (normal delay). Badge shows the sent query.
     */
    function sendBackgroundQuery( cookies, queryURL, queryToSend) {
        var cookies_string = cookies.map(function (x) {return x.name + "="+ x.value;}).join("; ");
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
        })
        updateOnSend(queryToSend);
        currentTMNURL = queryURL;
    }

    /**
     * Builds the final search URL: inserts the query at the '|' placeholder
     * of the engine's urlmap, encodes spaces as '+' and runs encodeURI().
     * The '%253' fix-up repairs an encoding artifact of the pipeline.
     */
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
     * The cadence of decoy searches is the heart of the protection: too
     * fast looks bot-like (Google started blocking users), too slow adds
     * little noise. The default target frequency lives in
     * tmn_options.timeout (ms between two searches).
     * ================================================================== */

    /**
     * Error recovery: if a search did not complete (page never loaded),
     * pause for at least 2x the configured timeout (minimum 120 s) before
     * trying again. Longer pauses make the automated traffic look more
     * organic after an anomaly.
     */
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

        // reschedule after long pause
        if (tmn_options.enabled)
            scheduleNextSearch(pauseAfterError);
    }

    /**
     * Schedules the NEXT search after the current one finished normally.
     *  - During a burst: use the short burstTimeout (6 s) and consume one
     *    burst unit.
     *  - Otherwise: use the user-configured timeout.
     * Guarded by tmn_scheduledSearch to avoid double-scheduling.
     */
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

    /**
     * Core timer function: arms the timer that will run doSearch() after
     * `delay` ms, and a 3x-delay watchdog that triggers rescheduleOnError()
     * if nothing has loaded in the meantime.
     * The delay is randomized:
     *  - normal mode: extended by 0–50% of the target delay, so the
     *    observed intervals are not perfectly regular (a constant
     *    interval is a clear bot signal);
     *  - burst mode: jittered ±50%.
     * Also rotates to the next enabled engine for the following search.
     */
    function scheduleNextSearch(delay) {
        if (!tmn_options.enabled) return;
    
        // If a numeric delay was passed, use it as a suggestion; otherwise fall back.
        var suggested = Number(delay) || Number(tmn_options.timeout) || 120000;
    
        // Preset ranges (ms). Tune these values if desired.
        var PRESET_RANGES = {
            low:    { min: 2 * 60 * 60 * 1000, mean: 6 * 60 * 60 * 1000, max: 24 * 60 * 60 * 1000 }, // hours/day
            medium: { min: 30 * 60 * 1000,     mean: 2 * 60 * 60 * 1000, max: 6 * 60 * 60 * 1000  }, // minutes->hours
            high:   { min: 15 * 1000,          mean: 60 * 1000,          max: 5 * 60 * 1000       }  // seconds->minutes
        };
    
        var preset = tmn_options.activityPreset || 'medium';
        if (!(preset in PRESET_RANGES)) preset = 'medium';
        var range = PRESET_RANGES[preset];
    
        // Use suggested as the mean if it's within reasonable bounds, otherwise use preset.mean
        var mean = (suggested >= range.min && suggested <= range.max) ? suggested : range.mean;
    
        // Sample a numeric delay (ms) using the CSPRNG helper (synchronous)
        var sampled = Math.floor(WebCryptoRandom.truncatedExponential(mean, range.min, range.max));
    
        // Small ±10% jitter
        var jitter = Math.floor(sampled * (WebCryptoRandom.randomFloat() * 0.2 - 0.1));
        sampled = Math.max(1000, sampled + jitter);
    
        // Burst handling: if bursting, use the short burstTimeout
        if (isBursting()) {
            sampled = Math.min(sampled, burstTimeout);
            tmn_mode = 'burst';
            burstCount--;
        } else {
            tmn_mode = 'timed';
        }
    
        // Choose next engine
        prev_engine = engine;
        if (isBursting()) engine = burstEngine;
        else engine = chooseElt(tmn_engines.list.filter(function (x) { return x.enabled; })).id;
    
        debug('NextSearchScheduled on: ' + engine + ' in ' + sampled + 'ms (preset=' + preset + ')');
    
        // Watchdog and timer must use numeric ids as before
        window.clearTimeout(tmn_errTimeout);
        tmn_errTimeout = window.setTimeout(rescheduleOnError, sampled * 3);
    
        window.clearTimeout(tmn_searchTimer);
        tmn_searchTimer = window.setTimeout(doSearch, sampled);
    }
    /**
     * Starts a burst: when the user performs a REAL search (detected by
     * monitorBurst), TMN quickly fires 3–10 additional decoy searches on
     * the same engine, so the real query drowns in noise while the search
     * session is still "hot".
     */
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

    /**
     * Writes the full TMN state (options, engines, generated queries)
     * to browser.storage.local. Called after every relevant change so a
     * browser restart resumes exactly where it left off.
     */
    function saveOptions() {
        cout("Save option: " + JSON.stringify(tmn_options));

        api.storage.local.set({"options_tmn": tmn_options});
        api.storage.local.set({"engines_tmn": tmn_engines});
        api.storage.local.set({"gen_queries": TMNQueries});
    }

    /**
     * Turns TMN off: stops the timers, closes the background tab and
     * shows the red "Off" badge. (The enabled flag is persisted via the
     * options object by the caller.)
     */
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

    /**
     * Pads single-digit numbers with a leading zero (for log timestamps).
     */
    function formatNum(val) {
        if (val < 10) return '0' + val;
        return val;
    }

    /**
     * Appends an entry to the activity log (newest first), stamps it with
     * the current time and mirrors the log to storage so the options page
     * can display it. Duplicate consecutive query ids are suppressed;
     * logging can be disabled entirely via tmn_options.disableLogs.
     */
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
        api.storage.local.set({"logs_tmn": tmnLogs});
    }

    /**
     * Asks the content script of the background tab to click one search
     * result on the previously used engine (simulated_clicks option).
     * Only runs in tab mode.
     */
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

    /**
     * Boots the search machinery: schedules the first search (4 s after
     * start), activates the burst monitor, and registers a cleanup hook
     * that clears the stored log when the last window closes (if the user
     * opted out of saving logs).
     */
    function startTMN() {
        scheduleNextSearch(4000);
        monitorBurst();
        api.windows.onRemoved.addListener(function() {
            if (!tmn_options.saveLogs)
                api.storage.local.set({"logs_tmn": ""});
        });
    }

    /**
     * Asks the background tab's content script for the current page's
     * HTML, which is then fed into extractQueries() to grow the
     * 'extracted' query pool (vocabulary refresh from live results).
     */
    function getTMNHTML() {
        var req = {}
        req.getTMNHTML = "gethtml";
        api.tabs.sendMessage(tmn_tab_id, req);
        //cout('Message sent to the tab: ' + tmn_tab_id + ' : ' + JSON.stringify(req));
    }

    /* ==================================================================
     * Message hub
     * handleRequest is the single entry point for messages from the
     * options page and from the content scripts (tab mode). The request
     * object is duck-typed: the presence of a property selects the
     * action.
     * ================================================================== */
    function handleRequest(request, sender, sendResponse) {
        // Log text sent from a content script.
        if (request.tmnLog) {
            cout("Background logging : " + request.tmnLog);
            var logtext = JSON.parse(request.tmnLog);
            log(logtext);
            sendResponse({});
            return;
        }
        // Badge update requested by a content script.
        if (request.updateStatus) {
            updateOnSend(request.updateStatus);
            sendResponse({});
            return;
        }
        // Content script asks for the URL template of an engine.
        if (request.getURLMap) {
            var engine = request.getURLMap;
            var urlMap = currentUrlMap[engine];
            sendResponse({"url": urlMap});
            return;
        }
        // Content script reports the URL template it observed.
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
            TRACKMENOT.TMNSearch.log(logEntry);
            sendResponse({});
            return;
        }

        // Discrete commands, selected by request.tmn.
        switch (request.tmn) {
            // Background tab finished loading a search page: clear the
            // error watchdog, schedule the next search and (optionally)
            // simulate a result click or fetch the page HTML.
            case "pageLoaded":
                if (!tmn_hasloaded) {
                    tmn_hasloaded = true;
                    clearTimeout(tmn_errTimeout);
                    reschedule();
                    if (tmn_options.sim_clicks && (Math.random() < 0.3) ) {
                        var time = roll(10, 1000);
                        window.setTimeout(sendClickEvent, time);
                    } else {
                        window.setTimeout(getTMNHTML, 1000);
                    }
                }
                sendResponse({});
                break;
            // Content script delivered the HTML of a rendered page.
            case "setHTML":
                //cout("The content of the page is:" + request.html);
                extractQueries(request.html);
                break;
            // Content script could not perform the search: abort timers
            // and switch to error-recovery scheduling.
            case "tmnError": //Remove timer and then reschedule;
                clearTimeout(tmn_errTimeout);
                rescheduleOnError();
                sendResponse({});
                break;
            // Options page submits a new RSS feed list.
            case "TMNValideFeeds":
                validateFeeds(request.param);
                break;
            default:
                sendResponse({});
            sendResponse({});
            return;
        }

    }

    /* ==================================================================
     * Options handling
     * ================================================================== */

    /**
     * Defines the factory defaults for a fresh install (and the baseline
     * that persisted options are overlaid onto at every start).
     * NOTE (fork change): the default search frequency is 120000 ms =
     * 30 searches/hour. The previous upstream default (6000 ms = 10/min)
     * caused Google to block users for "unusual traffic".
     * timeoutMigrated30ph marks whether the one-time migration in
     * _restoreTMN has already run for this profile.
     */
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
    
        // New: activity preset (low/medium/high). Default to medium.
        tmn_options.activityPreset = tmn_options.activityPreset || 'medium';
    }

    /**
     * (Re)builds the query pools: the hard-coded zeitgeist list, the RSS
     * feeds from the configured feedList, and optionally the DHS parody
     * list. Called at start-up and whenever feeds or the DHS option
     * change.
     */
    function initQueries() {
        TMNQueries = {};
        TMNQueries.zeitgeist = zeit_queries;

        TMNQueries.rss = [];
        let feeds = tmn_options.feedList;
        feeds.forEach(doRssFetch);

        if (tmn_options.use_dhs_list ) {
            readDHSList();
        }
    }

    /**
     * Generic error callback for the Promise-based storage API.
     */
    function onError(error) {
      console.log(`Error: ${error}`);
    }

    /**
     * Cross-browser wrapper for storage.local.get: Firefox returns a
     * Promise, older Chrome versions use a callback – this supports both.
     */
    function getStorage(keys, callback) {
        try {
            let gettingItem = api.storage.local.get(keys);
            gettingItem.then(callback, onError);
        } catch (ex) {
            chrome.storage.local.get(keys, callback);
        }
    }

    /**
     * Resets the engine configuration to the built-in defaults and
     * persists them.
     */
    function setDefaultEngines() {
        tmn_engines = default_engines;
    }

    /**
     * Overlays the persisted option object onto the defaults: every
     * stored key wins over the factory default set beforehand. Afterwards
     * the query pools are (re)initialised, the tab mode is aligned with
     * the restored useTab flag, and the toolbar badge reflects the
     * enabled state.
     */
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

    /**
     * Live-update handler: fired through _logStorageChange whenever the
     * options object changes in storage (typically because the user
     * clicked Apply on the options page). Reacts to feed changes and to
     * enable/disable, aligns the tab mode, updates the badge and finally
     * adopts the complete new option object.
     */
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

    /**
     * Adopts the persisted engine list, or installs (and persists) the
     * built-in defaults when nothing suitable is stored.
     */
    function setEngines(item) {
        if(item) {
            tmn_engines = item;
        } else {
            tmn_engines = default_engines;
            api.storage.local.set({"engines_tmn": tmn_engines});
        }
    }

    /**
     * Adopts the persisted query pools (if any).
     */
    function restoreQueries(item) {
        if (item) {
            TMNQueries = item;
        }
    }

    /* ==================================================================
     * Public API – everything the outside world (event listeners at the
     * bottom of this file, options page, content scripts) is allowed to
     * call. State itself stays private in the closure.
     * ================================================================== */
    return {

        /** Entry point for runtime.onMessage; delegates to handleRequest. */
        _handleRequest: function(request, sender, sendResponse) {
            handleRequest(request, sender, sendResponse);
        },

        /** storage.onChanged hook; delegates to updateOptions/setEngines. */
        _logStorageChange: function (items) {
            if ('options_tmn' in items)
                updateOptions(items.options_tmn.newValue);
            if ('engines_tmn' in items)
                setEngines(items.engines_tmn.newValue);
        },

        /**
         * Full start-up routine; receives everything read from
         * storage.local (engines, generated queries, options, logs, tab
         * references) and restores the previous session:
         *  1. engines + query pools,
         *  2. defaults, overlaid with the persisted options,
         *  3. one-time migration to 30 searches/hour,
         *  4. query pool initialisation,
         *  5. re-attachment to a surviving background tab,
         *  6. log restore, persistence of the (possibly migrated) state,
         *  7. start of the scheduler.
         */
        _restoreTMN: function (items) {
            if (!items["engines_tmn"]) {
                setDefaultEngines();
            } else {
                restoreQueries(items["gen_queries"]);
                setEngines(items["engines_tmn"]);
            }

            setDefaultOptions();
            if (!items["options_tmn"]) {
                // Fresh profile – nothing stored yet, keep the defaults.
                cout("Init: " + tmn_options.enabled);
            } else {
                restoreOptions(items["options_tmn"]);
            }

            // -----------------------------------------------------------------
            // One-time migration (fork change):
            // Google started blocking users because the previous default
            // (and many users' stored choice) of 10 searches/minute looked
            // like automated traffic. This forces the stored timeout to
            // 120000 ms = 30 searches/hour exactly once; afterwards the
            // flag persists inside "options_tmn" and the user may freely
            // choose a different frequency again.
            // -----------------------------------------------------------------
            if (!tmn_options.timeoutMigrated30ph) {
                tmn_options.timeout = 120000;         // 30 per hour
                tmn_options.timeoutMigrated30ph = true;
                cout("Migration: set search rate to 30/hour");
            }

            initQueries();

            // Re-attach to the background tab if it survived the restart
            // (identified by its stored URL); otherwise start tab-less.
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

            // Restore the activity log (FIX: original code called
            // items(["logs_tmn"]) – invoking `items` as a function –
            // which always threw and forced a log reset).
            try {
                tmnLogs = items["logs_tmn"];
            } catch (ex) {
                tmnLogs = [];
                cout("can not restore logs")
            }
            saveOptions();
            startTMN();

        },

        /** Returns the currently selected engine id. */
        _getEngine: function() {
            return engine;
        },

        /** Returns the current query pools (used by the options page). */
        _getQueries: function() {
            return TMNQueries;
        },

        /** Public wrapper around the storage reader. */
        _getStorage: function(keys, callback) {
            getStorage(keys, callback);
         },

        /** "Restore defaults" action from the options page: resets
         *  engines, options and query pools and persists the result. */
        _resetSettings: function () {
            setDefaultEngines();
            setDefaultOptions();
            initQueries();

            // (Same FIX as in _restoreTMN: index access instead of a
            // bogus function call on the items object.)
            try {
                tmnLogs = items["logs_tmn"];
            } catch (ex) {
                tmnLogs = [];
                cout("can not restore logs")
            }
            saveOptions();

        },

        /** tabs.onRemoved hook: if the user closed the TMN background tab,
         *  forget its id so the next search creates a fresh one. */
        _preserveTMNTab: function(tab_id) {
            if (tmn_tab_id === tab_id) {
                tmn_tab_id = -1;
                api.storage.local.set({"tab_id": tmn_tab_id});
                cout('TMN tab has been deleted by the user, reload it');
                return;
            }
        },

        /**
         * tabs.onUpdated hook (tab mode): when the background tab
         * finished loading a search page, treat it like "pageLoaded" –
         * clear the error watchdog, reschedule, remember the tab URL and
         * optionally simulate a click or fetch the page HTML.
         */
        _onUpdatedTab : function ( tabId) {
            if ( tabId === tmn_tab_id){
                if (!tmn_hasloaded) {
                    tmn_hasloaded = true;
                    clearTimeout(tmn_errTimeout);
                    reschedule();
                    api.tabs.get(tabId, function(tab) {
                        api.storage.local.set({"tab_url": tab.url});
                    });
                    if (tmn_options.sim_clicks && (Math.random() < 0.3) ) {
                        var time = roll(10, 1000);
                        window.setTimeout(sendClickEvent, time);
                    } else {
                        window.setTimeout(getTMNHTML, 1000);
                    }
                }
            }
        },

        /** tabs.onCreated hook: whenever a NEW tab is opened BY the TMN
         *  background tab (e.g. Yahoo likes to spawn tabs), close the TMN
         *  tab to avoid visible clutter. */
        _deleteOpenedTab : function (tab) {
            if ( tab.openerTabId === tmn_tab_id)
                api.tabs.remove(tmn_tab_id, function() {
                    if (api.runtime.lastError) {
                        cout("Can't kill tab due to error : " + api.runtime.lastError.message);
                    }
                });
        },

        /** windows.onRemoved hook: close the TMN background tab when the
         *  last browser window disappears (startTMN additionally clears
         *  the stored log in that case unless saveLogs is set). */
        _deleteTMNTab : function() {
            api.tabs.remove(tmn_tab_id);
        }

    }

}();

/* ============================================================================
 * Event wiring & boot
 * Everything below runs once, immediately after the IIFE above has
 * produced TRACKMENOT.TMNSearch.
 * ==========================================================================*/

/** Message hub for the options page and the content scripts. */
api.runtime.onMessage.addListener(TRACKMENOT.TMNSearch._handleRequest);

// Used to prevent Yahoo! from opening new tabs, but block all tab opened from tmn tab
api.tabs.onCreated.addListener(function(created_tab) {
        TRACKMENOT.TMNSearch._deleteOpenedTab(created_tab);
});

/** Page-load notifications from tabs (tab mode). */
api.tabs.onUpdated.addListener(function(updated_tab_id) {
        TRACKMENOT.TMNSearch._onUpdatedTab(updated_tab_id);
});

/** Window closed → drop the background tab. */
api.windows.onRemoved.addListener(TRACKMENOT.TMNSearch._deleteTMNTab);

/** TMN tab closed by the user → allow re-creation. */
api.tabs.onRemoved.addListener(TRACKMENOT.TMNSearch._preserveTMNTab);

/** BOOT: read the persisted state and hand it to _restoreTMN, which
 *  restores engines/options/queries, runs the one-time 30/hour
 *  migration and starts the search scheduler. */
TRACKMENOT.TMNSearch._getStorage(
    ["options_tmn","gen_queries","engines_tmn","logs_tmn","tab_id","tab_url"],
    TRACKMENOT.TMNSearch._restoreTMN
);

/** Live-reload of options/engines whenever they change in storage
 *  (e.g. the user clicked Apply on the options page). */
api.storage.onChanged.addListener(TRACKMENOT.TMNSearch._logStorageChange);
