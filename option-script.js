"use strict";

var api;
if (chrome == undefined) {
    api = browser;
} else {
    api = chrome;
}


var tmn_options = {};
var tmn_engines ={};
var tmn = api.extension.getBackgroundPage().TRACKMENOT.TMNSearch;
var options = {};




function loadHandlers() {
    $("#apply-options").unbind().click(function() {
         saveOptions();
         updateEngineList();
    });
    
    
    $("#clear-options").unbind().click(function() {
         clearOptions();
         updateEngineList();
    });

    $("#trackmenot-opt-help").unbind().click(function() {
        api.tabs.create({
            url: "https://github.com/paradonym/TrackMeNot"
        });
    });

    $("#trackmenot-opt-site").unbind().click(function() {
        api.tabs.create({
            url: "https://cs.nyu.edu/trackmenot"
        });

    });

    $("#show-add").unbind().click(function() {
        $("#add-engine-table").show();
    });
    $("#show-log").unbind().click(function() {
        api.storage.local.get(["logs_tmn"],TMNShowLog);
    });

    $("#trackmenot-opt-showqueries").click(function() {
        var tmn = api.extension.getBackgroundPage().TRACKMENOT.TMNSearch;
        var queries = tmn._getQueries();
        TMNShowQueries(queries);
    });
    
    $("#overlay_logs").unbind().click(TMNHideLog);
    
    $("#overlay_queries").unbind().click(TMNHideQueries);

    $("#validate-feed").unbind().click(function() {
        var feeds = $("#trackmenot-seed").val();
        var param = {
            "feeds": feeds
        };
        api.runtime.sendMessage({
            'tmn': "TMNValideFeeds",
            'param': param
        });
    });

    $("#clear-log").unbind().click(function() {
        // normalize to an empty array so TMNShowLog always sees an array
        api.storage.local.set({"logs_tmn": []});
    });


    $("#search-engine-list").on('click', 'button.smallbutton', function(event) {
        var del_engine = event.target.id.split("_").pop();
        delEngine(del_engine);
    });

    $("#trackmenot-opt-timeout").change(function() {
        var timeout = $("#trackmenot-opt-timeout").val();
        setFrequencyMenu(timeout);
    });



    $("#add-engine").unbind().click(function() {
        var engine = {};
        engine.name = $("#newengine-name").val();
        engine.urlmap = $("#newengine-map").val();
        if (engine.urlmap.indexOf('trackmenot') < 0) {
            alert("To add a new search engine url, search 'trackmenot' (without the quotes) on your desired search engine. Then, copy and paste the search url in the URL text box below.");
            return;
        }
        addEngine(engine);
    });
}

    function getEngIndexById(id) {
        for (var i = 0; i < tmn_engines.list.length; i++) {
            if (tmn_engines.list[i].id === id) return i;
        }
        return -1;
    }

     function updateEngineList() {
        tmn_engines.list.forEach(function (x) {return x.enabled = false;});
        $("#search-engine-list :checked").each(function() {
            console.log(($(this).val()));
            tmn_engines.list[getEngIndexById($(this).val())].enabled = true ;
        });
        api.storage.local.set({'engines_tmn':tmn_engines});
                                    
    }
    
    function clearOptions() {
        var tmn = api.extension.getBackgroundPage().TRACKMENOT.TMNSearch;
        api.storage.local.clear();
        tmn._resetSettings();
        getStorage(["engines_tmn","options_tmn"],TMNLoadOptionWindow );
    }

      function addEngine(param) {

        var new_engine = {};
        new_engine.name = param.name;
        new_engine.id = new_engine.name.toLowerCase();
        new_engine.urlmap = param.urlmap.replace('trackmenot', '|');
        var query_params = new_engine.urlmap.split('|');
        var kw_param = query_params[0].split('?')[1].split('&').pop();
        new_engine.regexmap = '^(' + new_engine.urlmap.replace(/\//g, "\\/").replace(/\./g, "\\.").split('?')[0] + "\\?.*?[&\\?]{1}" + kw_param + "(.*)$";
        new_engine.enabled = true;
        tmn_engines.list.push(new_engine);
        //cout("Added engine : " + new_engine.name + " url map is " + new_engine.urlmap);
        TMNShowEngines(tmn_engines) 
        updateEngineList();
    }



    function delEngine(del_engine) {
        tmn_engines.list = tmn_engines.list.filter(function(x) {return x.id !== del_engine;});
        TMNShowEngines(tmn_engines) 
        updateEngineList();
    }
    
    
function TMNSetOptionsMenu(item) {
    options =item; 
    var feedList = options.feedList.join('|');
    
    var kw_black_list = options.kwBlackList;
    //console.log("Enabled: " +options.enabled)
    $("#add-engine-table").hide();
    $("#trackmenot-opt-enabled").prop('checked', options.enabled);
    $("#trackmenot-opt-useTab").prop('checked', options.useTab);
                                                                
    $("#trackmenot-opt-burstMode").prop('checked', options.burstMode);
    $("#trackmenot-opt-sim-clicks").prop('checked', options.sim_clicks);
    $("#trackmenot-opt-save-logs").prop('checked', options.saveLogs);
    $("#trackmenot-opt-disable-logs").prop('checked', options.disableLogs);

    $("#trackmenot-seed").val(feedList);
    $("#trackmenot-blacklist").val(kw_black_list);
    $("#trackmenot-use-blacklist").prop('checked', options.use_black_list);
    $("#trackmenot-use-dhslist").prop('checked', options.use_dhs_list);

    setFrequencyMenu(options.timeout);
}




function setFrequencyMenu(timeout) {
    $('#trackmenot-opt-timeout option[value=' + timeout + ']').prop('selected', true);
}


function TMNHideLog() {
    $('#overlay_logs').css("display","none");
}

function TMNHideQueries() {
    $('#overlay_queries').css("display","none");
}

function TMNShowLog(items) {
    // Normalize and defend against bad/missing storage types.
    var logs = [];
    try {
        if (items && Object.prototype.hasOwnProperty.call(items, 'logs_tmn')) {
            var raw = items.logs_tmn;
            if (Array.isArray(raw)) {
                logs = raw;
            } else if (typeof raw === 'string') {
                var s = raw.trim();
                if (s.length) {
                    try {
                        var parsed = JSON.parse(s);
                        if (Array.isArray(parsed)) logs = parsed;
                    } catch (e) {
                        // not JSON — nothing to show
                        logs = [];
                    }
                } else {
                    logs = [];
                }
            } else {
                // unexpected type (number/null/object) — treat as empty
                logs = [];
            }
        }
    } catch (e) {
        logs = [];
    }

    if (!Array.isArray(logs) || logs.length === 0) {
        $('#tmn_logs_container').html('<div class="tmn-no-logs">No logs available.</div>');
        $('#overlay_logs').css('display','block');
        return;
    }

    var htmlStr = '<table cellspacing=3 id="overlaytext" width="800px" position="relative">';
    htmlStr += '<thead><tr align=left>';
    htmlStr += '<th>Engine</th>';
    htmlStr += '<th>Mode</th>';
    htmlStr += '<th>URL</th>';
    htmlStr += '<th>Query/Message</th>';
    htmlStr += '<th>Date</th>';
    htmlStr += '</tr></thead>';
    for (var i = 0; i < 3000 && i < logs.length; i++) {
        var entry = logs[i] || {};
        htmlStr += '<tr ';
        if (entry.type === 'ERROR') htmlStr += 'style="color:Red">';
        else if (entry.type === 'query') htmlStr += 'style="color:Black">';
        else if (entry.type === 'URLmap') htmlStr += 'style="color:Brown">';
        else if (entry.type === 'click') htmlStr += 'style="color:Blue">';
        else if (entry.type === 'info') htmlStr += 'style="color:Green">';
        else htmlStr += '>';

        htmlStr += entry.engine ? '<td><b>' + entry.engine + '</b></td>' : '<td></td>';
        htmlStr += entry.mode ? '<td>' + entry.mode + '</td>' : '<td></td>';
        htmlStr += entry.newUrl ? '<td>' + (String(entry.newUrl).substring(0, 50)) + '</td>' : '<td></td>';
        htmlStr += entry.query ? '<td>' + entry.query + '</td>' : '<td></td>';
        htmlStr += entry.date ? '<td>' + entry.date + '</td>' : '<td></td>';

        htmlStr += '</tr>';
    }
    htmlStr += '</table>';
    $('#tmn_logs_container').html(htmlStr);
    $('#overlay_logs').css('display','block');
}


function TMNShowEngines(item) {
    tmn_engines= item;
    var htmlStr = "<table>";
    for (var i = 0; i < tmn_engines.list.length; i++) {
        var engine = tmn_engines.list[i];
        let is_checked = engine.enabled? " checked " : "";
        htmlStr += '<div id="overlay"><tr >';
        htmlStr += '<td > <label><input valign="top" type="checkbox"  id="' + engine.id + '" value="' + engine.id + '" ' + is_checked +'">' + engine.name + '</label></td><td><button class="smallbutton" id="del_engine_' + engine.id + '" > &nbsp;&nbsp;- &nbsp;&nbsp;</button> </td>';
        htmlStr += '</tr></div>';
    }
    htmlStr += '</table>';
    $('#search-engine-list').html(htmlStr);
    
    loadHandlers();
}


