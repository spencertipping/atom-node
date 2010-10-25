// ATOM -> JSON translator | Spencer Tipping
// Licensed under the terms of the MIT source code license
// Released by Social Media Networks

  caterwaul.clone('std')(function (require) {

//   XML fetching.
//   We create an HTTP client to fetch the XML specified by the user. In this case it's the entire URL, so we just unescape it to get the URL they wanted.

    const fetch_xml = fn[hostname, url, cc][let[request = require('http').createClient(80, hostname).request('GET', url, {host: hostname})] in
                                            (request.end(), request.on('response', let[data = []] in fn[response][response.setEncoding('utf8'), response.on('data', fn[s][data.push(s)]),
                                                                                                                                                response.on('end',  fn_[cc(data.join(''))])]))];

//   XML -> JSON conversion.
//   Here's how this works. When we see a node, we create an object {attributes: node_attributes}. This then gets associated with the previous node and pushed onto the node stack (thus becoming
//   the active node). When we see text, we assign the 'text' attribute of the current node to it. When we leave a node, we pop the node stack.

//   If we see a node called X and the current node already has an X, then we convert it to an array and push the new node onto that array. This means that multiple nodes are handled correctly:

//   | <foo>
//       <bar>stuff</bar>
//       <bar>stuff</bar>
//     </foo>

//   For this example, 'foo' will look like this: {bar: [{text: stuff, attributes: {}}, {text: stuff, attributes: {}}]}. I would empty out the attributes if all they have is text, but that's more
//   difficult than I'd like to think about right now.

    const xml_to_json = fn[xml, cc][
                        let[result = {}, stack = [], parser = require('./sax.js').parser(true, {lowercasetags: true})] in
                        (parser.onopentag = fn[n][result[n.name] ? result[n.name].constructor === Array ?
                                                                     let[n = {attributes: n.attributes}, e = n.name] in (stack.push(result), result[e].push(result = n)) :
                                                                     let[n = {attributes: n.attributes}, e = n.name] in (stack.push(result), result[e] = [result[e], result = n]) :
                                                                   (stack.push(result), result[n.name] = {attributes: n.attributes}, result = result[n.name])],
                         parser.onclosetag = fn[name][result = stack.pop()],
                         parser.ontext = fn[s][result.text = (result.text || '') + s],
                         parser.onend = fn_[cc(result)],
                         parser.write(xml).close())];

//   JSON filtering.
//   We don't need all of the data that comes back, necessarily. In some cases the full XML document is huge and we just want a subset. I'm not implementing anything too involved here; it's
//   mainly just a simple query language that lets you filter out nodes in a collection. So, for example, if your XML looks like this:
//   
//   | <atom>
//       <entry>
//         <name>foo</name>
//         ...
//       </entry>
//       <entry>
//         <name>bar</name>
//         ...
//       </entry>
//       ...
//     </atom>

//   Then you could define a filter to restrict by name:

//   | http://this-server/www.server.com/foo/bar/bif.xml?entry(name=foo)

//   This will make sure that any entries at the top-level have the name 'foo'. Note that this filter applies only to collections; not to heterogeneous nodes.

    const filter_json = fn[json, node_name, selector, value][node_name.indexOf('.') > -1 ?
                                                              filter_json(json[node_name.split(/\./)[0]] || {}, node_name.split(/\./).slice(1).join('.'), selector, value) :
                                                              json[node_name] && json[node_name].constructor === Array &&
                                                                (json[node_name] = json[node_name].filter(fn[node][node[selector] && node[selector].text === value])),
                                                             json];

//   HTTP server.
//   This is simple. We accept requests of this form:

//   | http://this-server/www.server.com/foo/bar/bif.xml

//   The URL is unescaped to make sure that special characters get properly represented.

//     Request caching.
//     Because we don't want to hammer other servers, I keep a 15-minute cache. The deal is simple: Every so often the cache gets emptied, but until then the server can store things.

    const unescape = require('querystring').unescape;
    var cache = {}, listeners = {};
    setInterval(fn_[cache = {}, listeners = {}], 900000);
    require('http').createServer(fn[req, res][cache[req.url] ?
                                                (res.writeHead(200, {'content-type': 'text/json'}), res.end(cache[req.url])) :
                                                ((listeners[req.url] ?
                                                  listeners[req.url].push(res) :
                                                  (listeners[req.url] = [res],
                                                   fetch_xml(parts[1], unescape(parts[2]),
                                                     fn[xml][xml_to_json(xml, fn[json][parts[3] && (json = filter_json(json, unescape(parts[3]), unescape(parts[4]), unescape(parts[5]))),
                                                                                       listeners[req.url].forEach(fn[res][res.writeHead(200, {'content-type': 'text/javascript'}),
                                                                                                                          res.end(cache[req.url] = 'receiveAtomAsJson(#{JSON.stringify(json)})')]),
                                                                                       listeners[req.url] = null])])))),
                                              when[parts], where[parts = /\/?([^\/]+)([^\?]*)(?:\??([^(]+)\((\w+)=([^)]+)\))?/.exec(req.url)]]).listen(8081, '0.0.0.0');

    process.on('uncaughtException', fn[e][console.log('Exception: #{e}')]);
  }) (require);

// Generated by SDoc 
