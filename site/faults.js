"use strict";
(function () {
    /** Same origin. This is the only address in the file. */
    var ENDPOINT = "/api/fault";
    /**
     * A page that is failing in a loop must not become a flood. Five distinct
     * faults per page load is enough to identify the problem; the sixth tells us
     * nothing the fifth did not.
     */
    var MAX_PER_PAGE = 5;
    /** Caps, mirroring the server's. The server applies its own regardless. */
    var MAX_MESSAGE = 300;
    var MAX_STACK = 4000;
    /** What has been sent for this page load. A variable, not storage. */
    var sent = {};
    var count = 0;
    /**
     * A URL reduced to its address: no query, no hash — but the COORDINATES on
     * the end are kept.
     *
     * 🔴 A V8 FRAME PUTS THE LINE AND COLUMN AFTER THE QUERY. A frame reads
     * `fn (https://host/app.js?v=7:1614:11)`, so cutting at the `?` throws away
     * the only coordinates the frame has — and then the frame cannot be parsed and
     * the traceback arrives a line shorter. Keeping a tail of exactly two integers
     * loses nothing and lets nothing from the query through.
     */
    function withoutQuery(text) {
        var cut = text.search(/[?#]/);
        if (cut === -1)
            return text;
        var tail = /(:\d+:\d+)$/.exec(text.slice(cut));
        return text.slice(0, cut) + (tail ? tail[1] : "");
    }
    /** A script's address as a path on this site: no origin, no query, no hash. */
    function scriptPath(url) {
        if (typeof url !== "string" || url === "")
            return "";
        var bare = withoutQuery(url);
        var absolute = bare.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i);
        return absolute ? absolute[1] || "/" : bare;
    }
    /** Redact and cap one line of text. */
    function redact(value, limit) {
        if (typeof value !== "string" || value === "")
            return "";
        return value
            .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)"']*/gi, function (url) {
            return withoutQuery(url);
        })
            .replace(/(^|[\s("'=])(\/[^\s)"']*)/g, function (_whole, lead, path) {
            return lead + withoutQuery(path);
        })
            .slice(0, limit);
    }
    /**
     * The report, and every field in it.
     *
     *   route    the path of the page the reader was on — never the query
     *   message  the error's own words, query-stripped and capped
     *   stack    the traceback, query-stripped and capped
     *   source   the script's path on this site
     *   line     the line, as a number
     *   column   the column, as a number
     *
     * That is the whole payload. There is no visitor id, no account, no browser
     * string, no viewport, no referrer, and nothing read from the page.
     */
    function send(payload) {
        var body;
        try {
            body = JSON.stringify(payload);
        }
        catch (error) {
            return;
        }
        // A beacon first, because a fault often happens while the page is going away
        // and a normal fetch is cancelled with it. It is same-origin, so there is
        // nothing to negotiate and no preflight.
        try {
            if (typeof navigator.sendBeacon === "function") {
                var blob = new Blob([body], { type: "application/json" });
                if (navigator.sendBeacon(ENDPOINT, blob))
                    return;
            }
        }
        catch (error) {
            /* Not available, or refused. The fetch below is the fallback. */
        }
        try {
            fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: body,
                // Keeps the request alive across a navigation, the same job the beacon
                // does.
                keepalive: true,
            }).catch(function () {
                /* A report that cannot be delivered is not itself a fault. */
            });
        }
        catch (error) {
            /* As above. Nothing here is allowed to reach the page. */
        }
    }
    /** Report one fault, once, within the cap. */
    function report(message, stack, source, line, column) {
        try {
            if (count >= MAX_PER_PAGE)
                return;
            var text = redact(message, MAX_MESSAGE);
            if (text === "")
                return;
            var place = scriptPath(source);
            var at = typeof line === "number" && isFinite(line) ? Math.round(line) : 0;
            var key = text + "|" + place + "|" + String(at);
            if (sent[key])
                return;
            sent[key] = true;
            count += 1;
            send({
                route: redact(location.pathname, 200) || "/",
                message: text,
                stack: redact(stack, MAX_STACK),
                source: place,
                line: at,
                column: typeof column === "number" && isFinite(column) ? Math.round(column) : 0,
            });
        }
        catch (error) {
            /* A fault reporter that throws while handling a fault is worse than none. */
        }
    }
    /**
     * 🔴 CAPTURE, SO A SCRIPT THAT NEVER LOADED IS CAUGHT TOO.
     *
     * A module that 404s, or a script the network refused, fires an error on the
     * ELEMENT — and those do not bubble, so a listener on the bubble phase never
     * sees the one failure that leaves the page visibly dead with nothing in the
     * console to explain it. The capture phase does see it.
     *
     * The element check is deliberately narrow: a script or a stylesheet, whose
     * failure means the page is broken. A missing room graphic is one picture, not
     * a broken page, and those arrive in numbers.
     */
    window.addEventListener("error", function (event) {
        try {
            // A load failure fires on the ELEMENT and does not bubble, so `target`
            // is the script or stylesheet itself; an ordinary script error fires on
            // `window`, and `target` is not an element at all. That is the whole
            // distinction, and it is why this handler is registered for the capture
            // phase rather than the bubble.
            const target = event.target;
            if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
                const script = target instanceof HTMLScriptElement;
                report(script
                    ? "A script on this page did not load."
                    : "A stylesheet on this page did not load.", "", script ? target.src : target.href, 0, 0);
                return;
            }
            const failure = event.error;
            report(event.message, failure && failure.stack ? failure.stack : "", event.filename, event.lineno, event.colno);
        }
        catch (error) {
            /* as above */
        }
    }, true);
    /**
     * A promise nobody caught. This is the most common way a modern page fails
     * silently: the console has a warning, the reader has a spinner, and nothing
     * anywhere says the two are the same event.
     */
    window.addEventListener("unhandledrejection", function (event) {
        try {
            const reason = event.reason;
            let message;
            let stack = "";
            if (reason instanceof Error) {
                message = (reason.name || "Error") + ": " + reason.message;
                stack = reason.stack || "";
            }
            else if (reason && typeof reason === "object" && "message" in reason) {
                message = String(reason.message);
            }
            else {
                message = String(reason);
            }
            report(message, stack, "", 0, 0);
        }
        catch (error) {
            /* as above */
        }
    });
    /**
     * 🔴 A CAUGHT ERROR IS INVISIBLE UNLESS THE CATCH SENDS IT.
     *
     * George, 23 September 2026, verbatim: ***"if you have any try/catch rollbar
     * wont get it unless to invoke the catch err and send to rollbar."*** He is
     * right, and it is the limitation people assume an error reporter does not
     * have. A reporter sees two things and only two:
     *
     *   - an error that ESCAPED — `window.onerror`, hooked above;
     *   - a promise NOBODY handled — `unhandledrejection`, hooked above.
     *
     * **Anything inside `try { } catch` has been caught, and catching it means the
     * page chose to carry on.** The browser then tells nobody, so a fault a reader
     * is quietly working around is a fault nobody can ever fix. That is the whole
     * gap, and no amount of listening closes it: **the catch has to say so.**
     *
     * So this entry point exists, and there are two ways to use it:
     *
     *     window.ragFault?.(error, "reading the document");  // a fault, send it
     *
     *     // expected: a private-mode refusal to store; the visit still works
     *
     * **A catch must do one or the other, and `test/faults.test.js` fails on a
     * catch that does neither** — because the failure this guards against is a
     * catch added in six months that quietly swallows something, and a rule
     * written in a comment cannot stop that. It is the same principle as the case
     * gate: a record is read at the end, only a gate fires at the moment of work.
     *
     * It goes through `report`, so the cap, the de-duplication and the redaction
     * all apply: a step failing on every poll is ONE item with many occurrences,
     * not hundreds of items.
     *
     * 🔴 IT NEVER THROWS, AND IT NEVER REPORTS ITS OWN FAILURE. A reporter that
     * threw into the catch that called it would replace a handled fault with an
     * unhandled one, and a reporter that reported its own failure would loop for
     * ever.
     */
    function reportFault(error, where) {
        var label = typeof where === "string" && where !== "" ? where : "an unnamed step";
        var detail = error instanceof Error
            ? (error.name || "Error") + ": " + error.message
            : String(error);
        report("Failed while " + label + ". " + detail, error instanceof Error && error.stack ? error.stack : "", "", 0, 0);
    }
    /**
     * 🔴 ON THE WINDOW, AND NAMED, BECAUSE THE PAGE HAS TO BE ABLE TO REACH IT. It
     * is created here — before `consent.js` and before `app.js` — so it exists by
     * the time anything that can fail is running. The page calls it with `?.`, so
     * a page whose reporter did not load carries on without one instead of
     * breaking on the name.
     */
    window.ragFault = reportFault;
})();
