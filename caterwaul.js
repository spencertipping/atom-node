// Caterwaul JS | Spencer Tipping
// Licensed under the terms of the MIT source code license

(function (f) {return f(f)}) (function (self) {

// Introduction.
// Caterwaul implements a very small Lisp in JavaScript syntax. The syntax ends up looking much more like McCarthy's M-expressions than traditional S-expressions, due to the ease of embedding
// those in a JS-compatible grammar. Also, JavaScript convention makes square-bracket calls such as qs[foo] relatively uncommon, so I'm using that as the macro syntax (though of course you can
// define macros with other forms as well).

// The most important thing Caterwaul does is provide a quotation operator. For example:

// | caterwaul(function () {
//     return qs[x + 1];
//   });

// This function returns a syntax tree representing the expression 'x + 1'. (Its utility is debatable.) Caterwaul also includes macro-definition and quasiquoting (not quite like Lisp, though I
// imagine you could write a macro for that):

// | caterwaul(function () {
//     caterwaul.macro(qs[let (_ = _) in _], function (variable, value, expression) {
//       return qs[(function (_) {return _}).call(this, _)].s('_', [variable, expression, value]);
//     });
//     // Macro usable in future caterwaul()ed functions
//   });

// Or, more concisely (since macro definitions can be used inside other macro definitions when you define with rmacro):

// | var f = caterwaul(function () {
//     caterwaul.rmacro(qs[let (_ = _) in _], fn[variable, value, expression]
//                                              [qs[(fn[_][_]).call(this, _)].s('_', [variable, expression, value])]);
//   });

// See the 'Macroexpansion' section some distance below for more information.

//   Coding style.
//   I like to code using syntactic minimalism, and since this project is a hobby instead of work I've run with that style completely. This has some advantages and some disadvantages. Advantages
//   include (1) a very small gzipped/minified footprint (especially since these comments make up most of the file), (2) few lines of code, though they are very long, and (3) lots of semantic
//   factoring that should make modification relatively simple. Disadvantages are (1) completely impenetrable logic (especially without the comments) and (2) possibly suboptimal performance in
//   the small scale (depending on whether your JS interpreter is optimized for statements or expressions).

//   There are a couple of things worth knowing about as you're reading through this code. One is that invariants are generally coded as such; for example, the 'own' property lookup is factored
//   out of the 'has' function even though it would be trivial to write it inside. This is to indicate to JavaScript that Object.prototype.hasOwnProperty is relatively invariant, and that saves
//   some lookups as the code is running. Another is that I use the (function (variable) {return expression})(value) form to emulate let-bindings. (Reading the code with this in mind will make it
//   much more obvious what's going on.)

//   Utility methods.
//   fn(s) creates a function that returns 's', evaluated as an expression. It gets standard arguments $0, $1, ... $4, and has '@' replaced by 'this.' for Ruby-style instance variable access. I
//   use it a fair amount, but try to keep it outside of functions because it ends up calling eval(), which is slow. As a quick example, fn('$0 + $1') returns a function that adds its first two
//   arguments.

//   Gensym is used to support qs[]. When we quote syntax, what we really intend to do is grab a syntax tree representing something; this entails creating a let-binding with the already-evaluated
//   tree. (Note: Don't go and modify these qs[]-generated trees; you only get one for each qs[].) The ultimate code ends up looking like this (see 'Environment-dependent compilation' some
//   distance below):

//   | (function (a_gensym) {
//       return <your macroexpanded function>;
//     }) ({gensym_1: syntax_tree_1, gensym_2: syntax_tree_2, ..., gensym_n: syntax_tree_n});

//   A note about gensym uniqueness. Gensyms are astronomically unlikely to collide, but there are some compromises made to make sure of this. First, gensyms are not predictable; the first one is
//   randomized. This means that if you do have a collision, it may be intermittent (and that is probably a non-feature). Second, and this is a good thing, you can load Caterwaul multiple times
//   without worrying about gensyms colliding between them. Each instance of Caterwaul uses its own system time and random number to seed the gensym generation, and the system time remains stable
//   while the random number gets incremented. It is very unlikely that any collisions would happen.

//   Bind() is the usual 'bind this function to some value' function. The only difference is that it supports rebinding; that is, if you have a function you've already bound to X, you can call
//   bind on that function and some new value Y and get the original function bound to Y. The bound function has two attributes, 'original' and 'binding', that let bind() achieve this rebinding.

//   Map() is an array map function, fairly standard really. I include it because IE doesn't provide Array.prototype.map. hash() takes a string, splits it on whitespace, and returns an object
//   that maps each element to true. It's useful for defining sets. extend() takes a constructor function and zero or more extension objects, merging each extension object into the constructor
//   function's prototype. The constructor function is then returned. It's a shorthand for defining classes.

//   Se() stands for 'side-effect', and its purpose is to take a value and a function, pass the value into the function, and return either whatever the function returned or the value you gave it.
//   It's used to initialize things statefully; for example:

//   | return se(function () {return 5}, function (f) {
//       f.sourceCode = 'return 5';
//     });

    var fn = function (x) {return new Function ('$0', '$1', '$2', '$3', '$4', 'return ' + x.replace(/@/g, 'this.'))},  qw = fn('$0.split(/\\s+/)'),
    gensym = (function (n, m) {return function () {return '_gensym_' + n.toString(36) + '_' + (++m).toString(36) + '_'}})(+new Date(), Math.random() * (1 << 30) >>> 0),
        id = fn('$0'),

      bind = function (f, t) {return f.binding === t ? f : f.original ? bind(f.original, t) : merge(function () {return f.apply(t, arguments)}, {original: f, binding: t})},
       map = function (f, xs) {for (var i = 0, ys = [], l = xs.length; i < l; ++i) ys.push(f(xs[i], i)); return ys},
      hash = function (s) {for (var i = 0, xs = qw(s), o = {}, l = xs.length; i < l; ++i) o[xs[i]] = true; return annotate_keys(o)},
     merge = function (o) {for (var i = 1, l = arguments.length, _ = null; _ = arguments[i], i < l; ++i) if (_) for (var k in _) has(_, k) && (o[k] = _[k]); return o},
    extend = function (f) {merge.apply(null, [f.prototype].concat(Array.prototype.slice.call(arguments, 1))); return f},
        se = function (x, f) {return f && f.call(x, x) || x},

//   Optimizations.
//   The parser and lexer each assume valid input and do no validation. This is possible because any function passed in to caterwaul will already have been parsed by the JavaScript interpreter;
//   syntax errors would have caused an error there. This enables a bunch of optimization opportunities in the parser, ultimately making it not in any way recursive and requiring only three
//   linear-time passes over the token stream. (An approximate figure; it actually does about 19 fractional passes, but not all nodes are reached.)

//   Also, I'm not confident that all JavaScript interpreters are smart about hash indexing. Particularly, suppose a hashtable has 10 entries, the longest of whose keys is 5 characters. If we
//   throw a 2K string at it, it might very well hash that whole thing just to find that, surprise, the entry doesn't exist. That's a big performance hit if it happens very often. To prevent this
//   kind of thing, I'm keeping track of the longest string in the hashtable by using the 'annotate_keys' function. 'has()' knows how to look up the maximum length of a hashtable to verify that
//   the candidate is in it, resulting in the key lookup being only O(n) in the longest key (generally this ends up being nearly O(1), since I don't like to type long keys), and average-case O(1)
//   regardless of the length of the candidate.

    annotate_keys = function (o) {var max = 0; for (var k in o) own.call(o, k) && (max = k.length > max ? k.length : max); o._max_length = max; return o},
              has = function (o, p) {return p && ! (p.length > o._max_length) && own.call(o, p)},  own = Object.prototype.hasOwnProperty,

//   Global management.
//   Caterwaul creates a global symbol, caterwaul. Like jQuery, there's a mechanism to get the original one back if you don't want to replace it. You can call caterwaul.deglobalize() to return
//   caterwaul and restore the global that was there when Caterwaul was loaded. Note that deglobalize() is available only on the global caterwaul() function. It wouldn't make much sense for
//   clones to inherit it.

    _caterwaul = this.caterwaul,  _global = this,

// Syntax data structures.
// There are two data structures used for syntax trees. At first, paren-groups are linked into doubly-linked lists, described below. These are then folded into immutable array-based specific
// nodes. At the end of folding there is only one child per paren-group.

//   Doubly-linked paren-group lists.
//   When the token stream is grouped into paren groups it has a hierarchical linked structure that conceptually has these pointers:

//   |                       +--------+
//                  +------  |  node  |  ------+
//                  |   +->  |        |  <--+  |
//           first  |   |    +--------+     |  |  last
//                  |   | parent     parent |  |
//                  V   |                   |  V
//               +--------+               +--------+
//               |  node  |   --- r -->   |  node  |  --- r ---/
//    /--- l --- |        |   <-- l ---   |        |
//               +--------+               +--------+

//   The primary operation performed on this tree, at least initially, is repeated folding. So we have a chain of linear nodes, and one by one certain nodes fold their siblings underneath them,
//   breaking the children's links and linking instead to the siblings' neighbors. For example, if we fold node (3) as a binary operator:

//   |     (1) <-> (2) <-> (3) <-> (4) <-> (5)             (1) <--> (3) <--> (5)
//         / \     / \     / \     / \     / \     -->     / \     /   \     / \
//                                                                /     \
//                                                              (2)     (4)        <- No link between children
//                                                              / \     / \           (see 'Fold nodes', below)

//   Fold nodes.
//   Once a node has been folded (e.g. (3) in the diagram above), none of its children will change and it will gain no more children. The fact that none of its children will change can be shown
//   inductively: suppose you've decided to fold the '+' in 'x + y' (here x and y are arbitrary expressions). This means that x and y are comprised of higher-precedence operators. Since there is
//   no second pass back to high-precedence operators, x and y will not change nor will they interact with one another. The fact that a folded node never gains more children arrives from the fact
//   that it is folded only once; this is by virtue of folding by index instead of by tree structure. (Though a good tree traversal algorithm also wouldn't hit the same node twice -- it's just
//   less obvious when the tree is changing.)

//   Anyway, the important thing about fold nodes is that their children don't change. This means that an array is a completely reasonable data structure to use for the children; it certainly
//   makes the structure simpler. It also means that the only new links that must be added to nodes as they are folded are links to new children (via the array), and links to the new siblings.
//   Once we have the array-form of fold nodes, we can build a query interface similar to jQuery, but designed for syntactic traversal. This will make routine operations such as macro
//   transformation and quasiquoting far simpler later on.

//   Both grouping and fold nodes are represented by the same data structure. In the case of grouping, the 'first' pointer is encoded as [0] -- that is, the first array element. It doesn't
//   contain pointers to siblings of [0]; these are still accessed by their 'l' and 'r' pointers. As the structure is folded, the number of children of each paren group should be reduced to just
//   one. At this point the remaining element's 'l' and 'r' pointers will both be null, which means that it is in hierarchical form instead of linked form.

//   After the tree has been fully generated and we have the root node, we have no further use for the parent pointers. This means that we can use subtree sharing to save memory. Once we're past
//   the fold stage, push() should be used instead of append(). append() works in a bidirectionally-linked tree context (much like the HTML DOM), whereas push() works like it does for arrays
//   (i.e. no parent pointer).

       syntax_node_inspect = fn('$0 ? $0.inspect() : "(<>)"'),  syntax_node_tostring = fn('$0 ? $0.serialize ? $0.serialize() : $0.toString() : ""'),
               syntax_node = extend(function (data) {this.data = data; this.length = 0; this.l = this.r = this.p = null;
                                                     for (var i = 1, l = arguments.length, _; _ = arguments[i], i < l; ++i)
                                                       for (var j = 0, lj = _.length, it; _.constructor === Array ? (it = _[j], j < lj) : (it = _, ! j); ++j)
                                                         this.append(it.constructor === String ? new this.constructor(it) : it)},

                {replace: fn('($0.l = @l) && (@l.r = $0), ($0.r = @r) && (@r.l = $0), this'),    append_to: fn('$0 && $0.append(this), this'),
                reparent: fn('@p && @p[0] === this && (@p[0] = $0), this'),                         fold_l: fn('@append(@l && @l.unlink(this))'),  fold_lr: fn('@fold_l().fold_r()'),
                  append: fn('(this[@length++] = $0) && ($0.p = this), this'),                      fold_r: fn('@append(@r && @r.unlink(this))'),  fold_rr: fn('@fold_r().fold_r()'),
                 sibling: fn('$0.p = @p, (@r = $0).l = this'),                                      unlink: fn('@l && (@l.r = @r), @r && (@r.l = @l), @l = @r = null, @reparent($0)'),
                    wrap: fn('$0.p = @replace($0).p, @reparent($0), @l = @r = null, @append_to($0)'),  pop: fn('--@length, this'),  push: fn('(this[@length++] = $0), this'),

//     Traversal functions.
//     each() is the usual side-effecting shallow traversal that returns 'this'. map() distributes a function over a node's children and returns the array of results, also as usual. Two variants,
//     reach and rmap, perform the process recusrively. reach is non-consing; it returns the original as a reference. rmap, on the other hand, follows some rules to cons a new tree. If the
//     function passed to rmap() returns the node verbatim then its children are traversed. If it returns a distinct node, however, then traversal doesn't descend into the children of the newly
//     returned tree but rather continues as if the original node had been a leaf. For example:

//     |           parent          Let's suppose that a function f() has these mappings:
//                /      \
//            node1      node2       f(parent) = parent   f(node1) = q
//            /   \        |                              f(node2) = node2
//          c1     c2      c3

//     In this example, f() would be called on parent, node1, node2, and c3 in that order. c1 and c2 are omitted because node1 was replaced by q -- and there is hardly any point in going through
//     the replaced node's previous children. (Nor is there much point in forcibly iterating over the new node's children, since presumably they are already processed.) If a mapping function
//     returns something falsy, it will have exactly the same effect as returning the node without modification.

//     Reparenting is done automatically. That is, any node returned by a mapping function, regardless of its original parent, will be reparented into the correct node by map() or rmap().

//     The s() function maps the tree into a new one, where each node whose data is the given value is replaced by a successive entry in the array. The array wraps back to the beginning if you
//     hit the end. (Alternatively, if you provide a non-array as the second parameter, then each matching entry is replaced by the second parameter as-is.) It's designed to emulate
//     quasiquotation, like this:

//     | qs[(foo(_), _ + bar(_))].s('_', [qs[x], qs[3 + 5], qs[foo.bar]])

                    each: function (f) {for (var i = 0, l = this.length; i < l; ++i) f(this[i], i); return this},
                     map: function (f) {for (var n = new syntax_node(this.data), i = 0, l = this.length; i < l; ++i) n.push(f(this[i], i) || this[i]); return n},
                   reach: function (f) {f(this); this.each(function (n) {n && n.reach(f)}); return this},
                    rmap: function (f) {var r = f(this); return ! r || r === this ? this.map(function (n) {return n && n.rmap(f)}) : r},

                 collect: function (p) {var ns = []; this.reach(function (n) {p(n) && ns.push(n)}); return ns},
                 parents: function ()  {var ps = [], n = this.p; while (n) ps.push(n = n.p); return ps},

                       s: function (data, xs) {if (xs.constructor === Array) {var i = 0; return this.rmap(function (n) {return n.data === data && xs[i++ % xs.length]})}
                                               else                          return this.rmap(function (n) {return n.data === data && xs})},

        repopulated_with: function (xs)   {return new this.constructor(this.data, xs)},
                  change: function (i, x) {return se(new this.constructor(this.data, Array.prototype.slice.call(this)), function (n) {n[i] = x})},
          compose_single: function (i, f) {return this.change(i, f(this[i]))},

//     Structural transformation.
//     Having nested syntax trees can be troublesome. For example, suppose you're writing a macro that needs a comma-separated list of terms. It's a lot of work to dig through the comma nodes,
//     each of which is binary. JavaScript is better suited to using a single comma node with an arbitrary number of children. (This also helps with the syntax tree API -- we can use .map() and
//     .each() much more effectively.) Any binary operator can be transformed this way, and that is exactly what the flatten() method does. (flatten() returns a new tree; it doesn't modify the
//     original.)

//     The tree flattening operation looks like this for a left-associative binary operator:

//     |        (+)
//             /   \              (+)
//          (+)     z     ->     / | \
//         /   \                x  y  z
//        x     y

//     This flatten() method returns the nodes along the chain of associativity, always from left to right. It is shallow, since generally you only need a localized flat tree. That is, it doesn't
//     descend into the nodes beyond the one specified by the flatten() call.

                 flatten: function () {var d = this.data; return ! (has(parse_lr, d) && this.length) ? this : has(parse_associates_right, d) ?
                                                            se(new this.constructor(d), bind(function (n) {for (var i = this;     i && i.data === d; i = i[1]) n.push(i[0]); n.push(i)}, this)) :
                                                            se(new this.constructor(d), bind(function (n) {for (var i = this, ns = []; i.data === d; i = i[0]) i[1] && ns.push(i[1]); ns.push(i);
                                                                                                           for (i = ns.length - 1; i >= 0; --i) n.push(ns[i])}, this))},

//     Type detection and retrieval.
//     These methods are used to detect the literal type of a node and to extract that value if it exists. You should use the as_x methods only once you know that the node does represent an x;
//     otherwise you will get misleading results. (For example, calling as_boolean on a non-boolean will always return false.)

//     Other methods are provided to tell you higher-level things about what this node does. For example, is_contextualized_invocation() tells you whether the node represents a call that can't be
//     eta-reduced (if it were, then the 'this' binding would be lost).

               is_string: function () {return /['"]/.test(this.data.charAt(0))},               as_escaped_string: function () {return this.data.substr(1, this.data.length - 2)}, 
               is_number: function () {return /\d/.test(this.data) && ! /^[\/\w'"]/.test(this.data)},  as_number: function () {return Number(this.data)},
              is_boolean: function () {return this.data === 'true' || this.data === 'false'},         as_boolean: function () {return this.data === 'true'},
               is_regexp: function () {return /^\/./.test(this.data)},                         as_escaped_regexp: function () {return this.data.substring(1, this.data.lastIndexOf('/'))},

       has_grouped_block: function () {return has(parse_r_until_block, this.data)},                     is_block: function () {return has(parse_block, this.data)},

                is_empty: fn('!@length'),  is_constant: fn('@is_number() || @is_string() || @is_boolean() || @is_regexp() || @data === "null" || @data === "undefined"'),
          left_is_lvalue: fn('/=$/.test(@data) || /\\+\\+$/.test(@data) || /--$/.test(@data)'),   has_parameter_list: fn('@data === "function" || @data === "catch"'),
         has_lvalue_list: fn('@data === "var" || @data === "const"'),                                 is_dereference: fn('@data === "." || @data === "[]"'),
           is_invocation: fn('@data === "()"'),                                         is_contextualized_invocation: fn('@is_invocation() && this[0] && this[0].is_dereference()'),

//     Inspection and syntactic serialization.
//     Syntax nodes can be both inspected (producing a Lisp-like structural representation) and serialized (producing valid JavaScript code). Each representation captures stray links via the 'r'
//     pointer. In the serialized representation, it is shown as a comment /* -> */ followed by the serialization of whatever is to the right. This has the property that it will break tests but
//     won't necessarily break code (though if it happens in the field then it's certainly a bug).

//     There's a hack here for single-statement if-else statements. (See 'Grab-until-block behavior' in the parsing code below.) Basically, for various reasons the syntax tree won't munch the
//     semicolon and connect it to the expression, so we insert one automatically whenever the second node in an if, else, while, etc. isn't a block.

                toString: fn('@inspect()'),
                 inspect: function () {return (this.l ? '(left) <- ' : '') + '(' + this.data + (this.length ? ' ' + map(syntax_node_inspect, this).join(' ') : '') + ')' +
                                              (this.r ? ' -> ' + this.r.inspect() : '')},
               serialize: function () {var op = this.data, right = this.r ? '/* -> ' + this.r.serialize() + ' */' : '', space = /\w/.test(op.charAt(op.length - 1)) ? ' ' : '',
                                            s = has(parse_invisible, op) ? map(syntax_node_tostring, this).join(space) :
                                               has(parse_invocation, op) ? map(syntax_node_tostring, [this[0], op.charAt(0), this[1], op.charAt(1)]).join(space) :
                                                  has(parse_ternary, op) ? map(syntax_node_tostring, [this[0], op, this[1], parse_group[op], this[2]]).join(space) :
                                                    has(parse_group, op) ? op + map(syntax_node_tostring, this).join(space) + parse_group[op] :
                                                       has(parse_lr, op) ? this.length ? map(syntax_node_tostring, this).join(space + op + space) : op :
                           has(parse_r, op) || has(parse_r_optional, op) ? op.replace(/^u/, '') + space + (this[0] ? this[0].serialize() : '') :
                                            has(parse_r_until_block, op) ? has(parse_accepts, op) && this[1] && this[1].data !== '{' && this[2] && parse_accepts[op] === this[2].data ?
                                                                            op + space + map(syntax_node_tostring, [this[0], this[1], ';', this[2]]).join('') :
                                                                            op + space + map(syntax_node_tostring, this).join('') :
                                                        has(parse_l, op) ? (this[0] ? this[0].serialize() : '') + space + op : op;
                                       return right ? s + right : s}}),

//   Syntax folding.
//   The first thing to happen is that parenthetical, square bracket, and braced groups are folded up. This happens in a single pass that is linear in the number of tokens, and other foldable
//   tokens (including unary and binary operators) are indexed by associativity. The following pass runs through these indexes from high to low precedence and folds tokens into trees. By this
//   point all of the parentheticals have been replaced by proper nodes (here I include ?: groups in parentheticals, since they behave the same way). Finally, high-level rules are applied to the
//   remaining keywords, which are bound last. This forms a complete parse tree.

//   Doing all of this efficiently requires a linked list rather than an array. This gets built during the initial paren grouping stage. Arrays are used for the indexes, which are left-to-right
//   and are later processed in the order indicated by the operator associativity. That is, left-associative operators are processed 0 .. n and right associative are processed n .. 0. Keywords
//   are categorized by behavior and folded after all of the other operators. Semicolons are folded last, from left to right.

//   There are some corner cases due to JavaScript's questionable heritage from C-style syntax. For example, most constructs take either syntax blocks or semicolon-delimited statements. Ideally,
//   else, while, and catch are associated with their containing if, do, and try blocks, respectively. This can be done easily, as the syntax is folded right-to-left. Another corner case would
//   come up if there were any binary operators with equal precedence and different associativity. JavaScript doesn't have them however, and it wouldn't make much sense to; it would render
//   expressions such as 'a op1 b op2 c' ambiguous if op1 and op2 shared precedence but each wanted to bind first. (I mention this because at first I was worried about it, but now I realize it
//   isn't an issue.)

//   Notationally (for easier processing later on), a distinction is made between invocation and grouping, and between dereferencing and array literals. Dereferencing and function invocation are
//   placed into their own operators, where the left-hand side is the thing being invoked or dereferenced and the right-hand side is the paren-group or bracket-group that is responsible for the
//   operation. Also, commas inside these groups are flattened into a single variadic (possibly nullary) comma node so that you don't have to worry about the tree structure. This is the case for
//   all left-associative operators; right-associative operators preserve their hierarchical folding.

// Parsing.
// There are two distinct parts to parsing JavaScript. One is parsing the irregular statement-mode expressions such as 'if (condition) {...}' and 'function f(x) {...}'; the other is parsing
// expression-mode stuff like arithmetic operators. In Rebase I tried to model everything as an expression, but that failed sometimes because it required that each operator have fixed arity. In
// particular this was infeasible for keywords such as 'break', 'continue', 'return', and some others (any of these can be nullary or unary). It also involved creating a bizarre hack for 'case
// x:' inside a switch block. This hack made the expression passed in to 'case' unavailable, as it would be buried in a ':' node.

// Caterwaul fixes these problems by using a proper context-free grammar. However, it's much looser than most grammars because it doesn't need to validate anything. Correspondingly, it can be
// much faster as well. Instead of guessing and backtracking as a recursive-descent parser would, it classifies many different branches into the same basic structure and fills in the blanks. One
// example of this is the () {} pair, which occurs in a bunch of different constructs, including function () {}, if () {}, for () {}, etc. In fact, any time a () group is followed by a {} group
// we can grab the token that precedes () (along with perhaps one more in the case of function f () {}), and group that under whichever keyword is responsible.

//   Parse/lex shared logic.
//   Lexing JavaScript is not entirely straightforward, primarily because of regular expression literals. The first implementation of the lexer got things right 99% of the time by inferring the
//   role of a / by its preceding token. The problem comes in when you have a case like this:

//   | if (condition) /foo/.test(x)

//   In this case, (condition) will be incorrectly inferred to be a regular expression (since the close-paren terminates an expression, usually), and /foo/ will be interpreted as division by foo. 

//   We mark the position before a token and then just increment the position. The token, then, can be retrieved by taking a substring from the mark to the position. This eliminates the need for
//   intermediate concatenations. In a couple of cases I've gone ahead and done them anyway -- these are for operators, where we grab the longest contiguous substring that is defined. I'm not to
//   worried about the O(n^2) complexity due to concatenation; they're bounded by four characters.

//   OK, so why use charAt() instead of regular expressions? It's a matter of asymptotic performance. V8 implements great regular expressions (O(1) in the match length for the (.*)$ pattern), but
//   the substring() method is O(n) in the number of characters returned. Firefox implements O(1) substring() but O(n) regular expression matching. Since there are O(n) tokens per document of n
//   characters, any O(n) step makes lexing quadratic. So I have to use the only reliably constant-time method provided by strings, charAt() (or in this case, charCodeAt()).

//   Of course, building strings via concatenation is also O(n^2), so I also avoid that for any strings that could be long. This is achieved by using a mark to indicate where the substring begins,
//   and advancing i independently. The span between mark and i is the substring that will be selected, and since each substring both requires O(n) time and consumes n characters, the lexer as a
//   whole is O(n). (Though perhaps with a large constant.)

//     Precomputed table values.
//     The lexer uses several character lookups, which I've optimized by using integer->boolean arrays. The idea is that instead of using string membership checking or a hash lookup, we use the
//     character codes and index into a numerical array. This is guaranteed to be O(1) for any sensible implementation, and is probably the fastest JS way we can do this. For space efficiency, only
//     the low 256 characters are indexed. High characters will trigger sparse arrays, which may degrade performance. (I'm aware that the arrays are power-of-two-sized and that there are enough of
//     them, plus the right usage patterns, to cause cache line contention on most Pentium-class processors. If we are so lucky to have a JavaScript JIT capable enough to have this problem, I think
//     we'll be OK.)

//     The lex_op table indicates which elements trigger regular expression mode. Elements that trigger this mode cause a following / to delimit a regular expression, whereas other elements would
//     cause a following / to indicate division. By the way, the operator ! must be in the table even though it is never used. The reason is that it is a substring of !==; without it, !== would
//     fail to parse, which causes an infinite loop. (See test/lex-neq-failure for examples.)

         lex_op = hash('. new ++ -- u++ u-- u+ u- typeof u~ u! ! * / % + - << >> >>> < > <= >= instanceof in == != === !== & ^ | && || ? = += -= *= /= %= &= |= ^= <<= >>= >>>= : , ' +
                       'return throw case var const break continue void else u; ;'),

      lex_table = function (s) {for (var i = 0, xs = [false]; i < 8; ++i) xs = xs.concat(xs); for (var i = 0, l = s.length; i < l; ++i) xs[s.charCodeAt(i)] = true; return xs},
      lex_float = lex_table('.0123456789'),    lex_decimal = lex_table('0123456789'),  lex_integer = lex_table('0123456789abcdefABCDEFx'),  lex_exp = lex_table('eE'),
      lex_space = lex_table(' \n\r\t'),        lex_bracket = lex_table('()[]{}'),       lex_opener = lex_table('([{'),                    lex_punct = lex_table('+-*/%&|^!~=<>?:;.,'),
        lex_eol = lex_table('\n\r'),     lex_regexp_suffix = lex_table('gims'),          lex_quote = lex_table('\'"/'),                   lex_slash = '/'.charCodeAt(0),
       lex_star = '*'.charCodeAt(0),              lex_back = '\\'.charCodeAt(0),             lex_x = 'x'.charCodeAt(0),                     lex_dot = '.'.charCodeAt(0),
       lex_zero = '0'.charCodeAt(0),     lex_postfix_unary = hash('++ --'),              lex_ident = lex_table('$_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),

//     Parse data.
//     The lexer and parser aren't entirely separate, nor can they be considering the complexity of JavaScript's grammar. The lexer ends up grouping parens and identifying block constructs such
//     as 'if', 'for', 'while', and 'with'. The parser then folds operators and ends by folding these block-level constructs.

    parse_reduce_order = map(hash, ['function', '( [ . [] ()', 'new', 'u++ u-- ++ -- typeof u~ u! u+ u-', '* / %', '+ -', '<< >> >>>', '< > <= >= instanceof in', '== != === !==', '&', '^',
                                    '|', '&&', '||', 'case', '?', '= += -= *= /= %= &= |= ^= <<= >>= >>>=', ':', ',', 'return throw break continue delete void', 'var const',
                                    'if else try catch finally for switch with while do', ';']),

parse_associates_right = hash('= += -= *= /= %= &= ^= |= <<= >>= >>>= ~ ! new typeof u+ u- -- ++ u-- u++ ? if else function try catch finally for switch case with while do'),
   parse_inverse_order = (function (xs) {for (var  o = {}, i = 0, l = xs.length; i < l; ++i) for (var k in xs[i]) has(xs[i], k) && (o[k] = i); return annotate_keys(o)}) (parse_reduce_order),
   parse_index_forward = (function (rs) {for (var xs = [], i = 0, l = rs.length, _ = null; _ = rs[i], xs[i] = true, i < l; ++i)
                                           for (var k in _) if (has(_, k) && (xs[i] = xs[i] && ! has(parse_associates_right, k))) break; return xs}) (parse_reduce_order),

              parse_lr = hash('[] . () * / % + - << >> >>> < > <= >= instanceof in == != === !== & ^ | && || = += -= *= /= %= &= |= ^= <<= >>= >>>= , : ;'),
   parse_r_until_block = annotate_keys({'function':2, 'if':1, 'do':1, 'catch':1, 'try':1, 'for':1, 'while':1, 'with':1}),
         parse_accepts = annotate_keys({'if':'else', 'do':'while', 'catch':'finally', 'try':'catch'}),  parse_invocation = hash('[] ()'),
      parse_r_optional = hash('return throw break continue else'),           parse_l = hash('++ --'),            parse_r = hash('u+ u- u! u~ u++ u-- new typeof finally var const void delete'),
           parse_block = hash('; {'),  parse_k_empty = fn('[]'),         parse_group = annotate_keys({'(':')', '[':']', '{':'}', '?':':'}),  parse_invisible = hash('i;'),
 parse_ambiguous_group = hash('[ ('),  parse_ternary = hash('?'),  parse_not_a_value = hash('function if for while catch'),            parse_also_expression = hash('function'),

//   Parse function.
//   As mentioned earlier, the parser and lexer aren't distinct. The lexer does most of the heavy lifting; it matches parens and brackets, arranges tokens into a hierarchical linked list, and
//   provides an index of those tokens by their fold order. It does all of this by streaming tokens into a micro-parser whose language is grouping and that knows about the oddities required to
//   handle regular expression cases. In the same function, though as a distinct case, the operators are folded and the syntax is compiled into a coherent tree form.

      parse = function (s) {

//     Lex variables.
//     s, obviously, is the string being lexed. mark indicates the position of the stream, while i is used for lookahead. The difference is later read into a token and pushed onto the result. c
//     is a temporary value used to store the current character code. re is true iff a slash would begin a regular expression. esc is a flag indicating whether the next character in a string or
//     regular expression literal is escaped. exp indicates whether we've seen the exponent marker in a number. close is used for parsing single and double quoted strings; it contains the
//     character code of the closing quotation mark. t is the token to be processed.

//     Parse variables.
//     grouping_stack and gs_top are used for paren/brace/etc. matching. head and parent mark two locations in the linked syntax tree; when a new group is created, parent points to the opener
//     (i.e. (, [, ?, or {), while head points to the most recently added child. (Hence the somewhat complex logic in push().) indexes[] determines reduction order, and contains references to the
//     nodes in the order in which they should be folded. invocation_nodes is an index of the nodes that will later need to be flattened.

//     The push() function manages the mechanics of adding a node to the initial linked structure. There are a few cases here; one is when we've just created a paren group and have no 'head'
//     node; in this case we append the node as 'head'. Another case is when 'head' exists; in that case we update head to be the new node, which gets added as a sibling of the old head.

        var s = s.toString(), mark = 0, c = 0, re = true, esc = false, dot = false, exp = false, close = 0, t = '', i = 0, l = s.length, cs = function (i) {return s.charCodeAt(i)},
            grouping_stack = [], gs_top = null, head = null, parent = null, indexes = map(parse_k_empty, parse_reduce_order), invocation_nodes = [], all_nodes = [],
            new_node = function (n) {return all_nodes.push(n), n}, push = function (n) {return head ? head.sibling(head = n) : (head = n.append_to(parent)), new_node(n)};

//     Main lex loop.
//     This loop takes care of reading all of the tokens in the input stream. At the end, we'll have a linked node structure with paren groups. At the beginning, we set the mark to the current
//     position (we'll be incrementing i as we read characters), munch whitespace, and reset flags.

        while ((mark = i) < l) {
          while (lex_space[c = cs(i)] && i < l) mark = ++i;
          esc = exp = dot = t = false;

//       Miscellaneous lexing.
//       This includes bracket resetting (the top case, where an open-bracket of any sort triggers regexp mode) and comment removal. Both line and block comments are removed by comparing against
//       lex_slash, which represents /, and lex_star, which represents *.

            if                                        (lex_bracket[c])                                                                    {t = !! ++i; re = lex_opener[c]}
       else if (c === lex_slash && cs(i + 1) === lex_star && (i += 2)) {while (++i < l && cs(i) !== lex_slash || cs(i - 1) !== lex_star);  t = !  ++i}
       else if            (c === lex_slash && cs(i + 1) === lex_slash) {while                              (++i < l && ! lex_eol[cs(i)]);  t = false}

//       Regexp and string literal lexing.
//       These both take more or less the same form. The idea is that we have an opening delimiter, which can be ", ', or /; and we look for a closing delimiter that follows. It is syntactically
//       illegal for a string to occur anywhere that a slash would indicate division (and it is also illegal to follow a string literal with extra characters), so reusing the regular expression
//       logic for strings is not a problem. (This follows because we know ahead of time that the JavaScript is valid.)

       else if (lex_quote[c] && (close = c) && re && ! (re = ! (t = s.charAt(i)))) {while (++i < l && (c = cs(i)) !== close || esc)  esc = ! esc && c === lex_back;
                                                                                    while     (++i < l && lex_regexp_suffix[cs(i)])                               ; t = true}

//       Numeric literal lexing.
//       This is far more complex than the above cases. Numbers have several different formats, each of which requires some custom logic. The reason we need to parse numbers so exactly is that it
//       influences how the rest of the stream is lexed. One example is '0.5.toString()', which is perfectly valid JavaScript. What must be output here, though, is '0.5', '.', 'toString', '(',
//       ')'; so we have to keep track of the fact that we've seen one dot and stop lexing the number on the second.

//       Another case is exponent-notation: 3.0e10. The hard part here is that it's legal to put a + or - on the exponent, which normally terminates a number. Luckily we can safely skip over any
//       character that comes directly after an E or e (so long as we're really in exponent mode, which I'll get to momentarily), since there must be at least one digit after an exponent.

//       The final case, which restricts the logic somewhat, is hexadecimal numbers. These also contain the characters 'e' and 'E', but we cannot safely skip over the following character, and any
//       decimal point terminates the number (since '0x5.toString()' is also valid JavaScript). The same follows for octal numbers; the leading zero indicates that there will be no decimal point,
//       which changes the lex mode (for example, '0644.toString()' is valid).

//       So, all this said, there are different logic branches here. One handles guaranteed integer cases such as hex/octal, and the other handles regular numbers. The first branch is triggered
//       whenever a number starts with zero and is followed by 'x' or a digit (for conciseness I call 'x' a digit), and the second case is triggered when '.' is followed by a digit, or when a
//       digit starts.

//       A trivial change, using regular expressions, would reduce this logic significantly. I chose to write it out longhand because (1) it's more fun that way, and (2) the regular expression
//       approach has theoretically quadratic time in the length of the numbers, whereas this approach keeps things linear. Whether or not that actually makes a difference I have no idea.

//       Finally, in response to a recently discovered failure case, a period must be followed by a digit if it starts a number. The failure is the string '.end', which will be lexed as '.en',
//       'd' if it is assumed to be a floating-point number. (In fact, any method or property beginning with 'e' will cause this problem.)

       else if                  (c === lex_zero && lex_integer[cs(i + 1)]) {while (++i < l && lex_integer[cs(i)]); re = ! (t = true)}
       else if (lex_float[c] && (c !== lex_dot || lex_decimal[cs(i + 1)])) {while (++i < l && (lex_decimal[c = cs(i)] || (dot ^ (dot |= c === lex_dot)) || (exp ^ (exp |= lex_exp[c] && ++i))));
                                                                            while (i < l && lex_decimal[cs(i)]) ++i; re = ! (t = true)}

//       Operator lexing.
//       The 're' flag is reused here. Some operators have both unary and binary modes, and as a heuristic (which happens to be accurate) we can assume that anytime we expect a regular
//       expression, a unary operator is intended. The only exception are ++ and --, which are always unary but sometimes are prefix and other times are postfix. If re is true, then the prefix
//       form is intended; otherwise, it is postfix. For this reason I've listed both '++' and 'u++' (same for --) in the operator tables; the lexer is actually doing more than its job here by
//       identifying the variants of these operators.

//       The only exception to the regular logic happens if the operator is postfix-unary. (e.g. ++, --.) If so, then the re flag must remain false, since expressions like 'x++ / 4' can be valid.

       else if (lex_punct[c] && (t = re ? 'u' : '', re = true)) {while (i < l && lex_punct[cs(i)] && has(lex_op, t + s.charAt(i)))  t += s.charAt(i++); re = ! has(lex_postfix_unary, t)}

//       Identifier lexing.
//       If nothing else matches, then the token is lexed as a regular identifier or JavaScript keyword. The 're' flag is set depending on whether the keyword expects a value. The nuance here is
//       that you could write 'x / 5', and it is obvious that the / means division. But if you wrote 'return / 5', the / would be a regexp delimiter because return is an operator, not a value. So
//       at the very end, in addition to assigning t, we also set the re flag if the word turns out to be an operator.

       else {while (++i < l && lex_ident[cs(i)]); re = has(lex_op, t = s.substring(mark, i))}

//       Token unification.
//       t will contain true, false, or a string. If false, no token was lexed; this happens when we read a comment, for example. If true, the substring method should be used. (It's a shorthand to
//       avoid duplicated logic.) For reasons that are not entirely intuitive, the lexer sometimes produces the artifact 'u;'. This is never useful, so I have a case dedicated to removing it.

        if (i === mark) throw new Error('Internal error: The lexer failed to consume input and is throwing this error instead of entering an infinite loop. This is probably a Caterwaul bug.');
        if (t === false) continue;
        t = t === true ? s.substring(mark, i) : t === 'u;' ? ';' : t;

//       Grouping and operator indexing.
//       Now that we have a token, we need to see whether it affects grouping status. There are a couple of possibilities. If it's an opener, then we create a new group; if it's a matching closer
//       then we close the current group and pop out one layer. (We don't check for matching here. Any code provided to Caterwaul will already have been parsed by the host JavaScript interpreter,
//       so we know that it is valid.)

//       All operator indexing is done uniformly, left-to-right. Note that the indexing isn't strictly by operator. It's by reduction order, which is arguably more important. That's what the
//       parse_inverse_order table does: it maps operator names to parse_reduce_order subscripts. (e.g. 'new' -> 2.)

        t === gs_top ? (grouping_stack.pop(), gs_top = grouping_stack[grouping_stack.length - 1], head = head ? head.p : parent, parent = null) :
                       (has(parse_group, t) ? (grouping_stack.push(gs_top = parse_group[t]), parent = push(new_node(new syntax_node(t))), head = null) : push(new_node(new syntax_node(t))),
                        has(parse_inverse_order, t) && indexes[parse_inverse_order[t]].push(head || parent));

//       Regexp flag special cases.
//       Normally a () group wraps an expression, so a following / would indicate division. The only exception to this is when we have a block construct; in this case, the next token appears in
//       statement-mode, which means that it begins, not modifies, a value. We'll know that we have such a case if (1) the immediately-preceding token is a close-paren, and (2) a block-accepting
//       syntactic form occurs to its left.

//       With all this trouble over regular expressions, I had to wonder whether it was possible to do it more cleanly. I don't think it is, unfortunately. Even lexing the stream backwards fails
//       to resolve the ambiguity:

//       | for (var k in foo) /foo/g.test(k) && bar();

//       In this case we won't know it's a regexp until we hit the 'for' keyword (or perhaps 'var', if we're being clever -- but a 'with' or 'if' would require complete lookahead). A perfectly
//       valid alternative parse, minus the 'for' and 'var', is this:

//       | ((k in foo) / (foo) / (g.test(k))) && bar();

//       The only case where reverse-lexing is useful is when the regexp has no modifiers.

        re |= t === ')' && head.l && has(parse_r_until_block, head.l.data)}

//     Operator fold loop.
//     This is the second major part of the parser. Now that we've completed the lex process, we can fold operators and syntax, and take care of some exception cases.

//     First step: fold function literals, function calls, dots, and dereferences.
//     I'm treating this differently from the generalized operator folding because of the syntactic inference required for call and dereference detection. Nothing has been folded at this point
//     (with the exception of paren groups, which is appropriate), so if the node to the left of any ( or [ group is an operator, then the ( or [ is really a paren group or array literal. If, on
//     the other hand, it is another value, then the group is a function call or a dereference. This folding goes left-to-right. The reason we also process dot operators is that they share the same
//     precedence as calls and dereferences. Here's what a () or [] transform looks like:

//     |   quux <--> foo <--> ( <--> bar                              quux <--> () <--> bar
//                             \                                               /  \                  <-- This can be done by saying _.l.wrap(new node('()')).p.fold_r().
//                              bif <--> , <--> baz       -->               foo    (                     _.l.wrap() returns l again, .p gets the wrapping node, and fold_r adds a child to it.
//                                                                                  \
//                                                                                   bif <--> , <--> baz

//     This is actually merged into the for loop below, even though it happens before other steps do. See the 'ambiguous parse groups' section.

//     Second step: fold operators.
//     Now we can go through the list of operators, folding each according to precedence and associativity. Highest to lowest precedence here, which is just going forwards through the indexes[]
//     array. The parse_index_forward[] array indicates which indexes should be run left-to-right and which should go right-to-left.

        for (var i = 0, l = indexes.length, forward = null, _ = null; _ = indexes[i], forward = parse_index_forward[i], i < l; ++i)  
          for (var j = forward ? 0 : _.length - 1, lj = _.length, inc = forward ? 1 : -1, node = null, data = null; node = _[j], data = node && node.data, forward ? j < lj : j >= 0; j += inc)

//       Binary node behavior.
//       The most common behavior is binary binding. This is the usual case for operators such as '+' or ',' -- they grab one or both of their immediate siblings regardless of what they are.
//       Operators in this class are considered to be 'fold_lr'; that is, they fold first their left sibling, then their right.

            if (has(parse_lr, data)) node.fold_lr();

//       Ambiguous parse groups.
//       As mentioned above, we need to determine whether grouping constructs are invocations or real groups. This happens to take place before other operators are parsed (which is good -- that way
//       it reflects the precedence of dereferencing and invocation). The only change we need to make is to discard the explicit parenthetical or square-bracket grouping for invocations or
//       dereferences, respectively. It doesn't make much sense to have a doubly-nested structure, where we have a node for invocation and another for the group on the right-hand side of that
//       invocation. Better is to modify the group in-place to represent an invocation.

//       We can't solve this problem here, but we can solve it after the parse has finished. I'm pushing these invocation nodes onto an index for the end.

       else if (has(parse_ambiguous_group, data) && node.l && (node.l.data === '.' ||
                     ! (has(lex_op, node.l.data) || has(parse_not_a_value, node.l.data))))  invocation_nodes.push(node.l.wrap(new_node(new syntax_node(data + parse_group[data]))).p.fold_r());

//       Unary left and right-fold behavior.
//       Unary nodes have different fold directions. In this case, it just determines which side we grab the node from. I'm glad that JavaScript doesn't allow stuff like '++x++', which would make
//       the logic here actually matter. Because there isn't that pathological case, exact rigidity isn't required.

       else if (has(parse_l, data))  node.fold_l();
       else if (has(parse_r, data))  node.fold_r();

//       Ternary operator behavior.
//       This is kind of interesting. If we have a ternary operator, then it will be treated first as a group; just like parentheses, for example. This is the case because the ternary syntax is
//       unambiguous for things in the middle. So, for example, '3 ? 4 : 5' initially parses out as a '?' node whose child is '4'. Its siblings are '3' and '5', so folding left and right is an
//       obvious requirement. The only problem is that the children will be in the wrong order. Instead of (3) (4) (5), we'll have (4) (3) (5). So after folding, we do a quick swap of the first two
//       to set the ordering straight.

       else if (has(parse_ternary, data)) {node.fold_lr(); var temp = node[1]; node[1] = node[0]; node[0] = temp}

//       Grab-until-block behavior.
//       Not quite as simple as it sounds. This is used for constructs such as 'if', 'function', etc. Each of these constructs takes the form '<construct> [identifier] () {}', but they can also
//       have variants that include '<construct> () {}', '<construct> () statement;', and most problematically '<construct> () ;'. Some of these constructs also have optional child components; for
//       example, 'if () {} else {}' should be represented by an 'if' whose children are '()', '{}', and 'else' (whose child is '{}'). The tricky part is that 'if' doesn't accept another 'if' as a
//       child (e.g. 'if () {} if () {}'), nor does it accept 'for' or any number of other things. This discrimination is encoded in the parse_accepts table.

//       There are some weird edge cases, as always. The most notable is what happens when we have nesting without blocks:

//       | if (foo) bar; else bif;

//       In this case we want to preserve the semicolon on the 'then' block -- that is, 'bar;' should be its child; so the semicolon is required. But the 'bif' in the 'else' case shouldn't have a
//       semicolon, since that separates top-level statements. Because desperate situations call for desperate measures, there's a hack specifically for this in the syntax tree serialization.

//       One more thing. Firefox rewrites syntax trees, and one of the optimizations it performs on object literals is removing quotation marks from regular words. This means that it will take the
//       object {'if': 4, 'for': 1, etc.} and render it as {if: 4, for: 1, etc.}. As you can imagine, this becomes a big problem as soon as the word 'function' is present in an object literal. To
//       prevent this from causing problems, I only collapse a node if it is not followed by a colon. (And the only case where any of these would legally be followed by a colon is as an object
//       key.)

       else if (has(parse_r_until_block, data) && node.r && node.r.data !== ':')  
                                                 {for (var count = 0, limit = parse_r_until_block[data]; count < limit && node.r && ! has(parse_block, node.r.data); ++count) node.fold_r();
                                                  node.r && node.r.data !== ';' && node.fold_r();
                                                  if (has(parse_accepts, data) && parse_accepts[data] === (node.r && node.r.r && node.r.r.data)) node.fold_r().pop().fold_r();
                                             else if (has(parse_accepts, data) && parse_accepts[data] === (node.r && node.r.data))               node.fold_r()}

//       Optional right-fold behavior.
//       The return, throw, break, and continue keywords can each optionally take an expression. If the token to the right is an expression, then we take it, but if the token to the right is a
//       semicolon then the keyword should be nullary.

       else if (has(parse_r_optional, data))  node.r && node.r.data !== ';' && node.fold_r();

//     Third step.
//     Find all elements with right-pointers and wrap them with semicolon nodes. This is necessary because of certain constructs at the statement-level don't use semicolons; they use brace syntax
//     instead. (e.g. 'if (foo) {bar} baz()' is valid, even though no semicolon precedes 'baz()'.) By this point everything else will already be folded. Note that this does some weird things to
//     associativity; in general, you can't make assumptions about the exact layout of semicolon nodes. Fortunately semicolon is associative, so it doesn't matter in practice. And just in case,
//     these nodes are 'i;' rather than ';', meaning 'inferred semicolon' -- that way it's clear that they aren't original. (They also won't appear when you call toString() on the syntax tree.)

        for (var i = all_nodes.length - 1, _; _ = all_nodes[i], i >= 0; --i)  _.r && _.wrap(new syntax_node('i;')).p.fold_r();

//     Fourth step.
//     Flatten out all of the invocation nodes. As explained earlier, they are nested such that the useful data on the right is two levels down. We need to grab the grouping construct on the
//     right-hand side and remove it so that only the invocation or dereference node exists. During the parse phase we built an index of all of these invocation nodes, so we can iterate through
//     just those now. I'm preserving the 'p' pointers, though they're probably not useful beyond here.

        for (var i = 0, l = invocation_nodes.length, _, child; _ = invocation_nodes[i], i < l; ++i) (child = _[1] = _[1][0]) && (child.p = _);

        while (head.p) head = head.p;
        return head},

// Macroexpansion.
// Caterwaul is a Lisp, which in this case means that it provides the ability to transform code before that code is compiled. Lisp does macroexpansion inline; that is, as the code is being read
// (or compiled -- there are several stages I believe). Caterwaul provides offline macros instead; that is, you define them separately from their use. This gives Caterwaul some opportunity to
// optimize macro-rewriting.

// Defining offline macros is done in the normal execution path. For example:

// | caterwaul(function () {
//     caterwaul.rmacro(qs[let (_ = _) in _], fn[n, v, e][qs[fn[_][_].call(this, _)].s('_', [n, e, v])]);
//   }) ();        // Must invoke the function

// | // Macro is usable in this function:
//   caterwaul(function () {
//     let (x = 5) in console.log(x);
//   });

// Wrapping the first function in caterwaul() wasn't necessary, though it was helpful to get the qs[] and fn[] shorthands. In this case, the macro is persistent to the caterwaul function that it
// was called on. (So any future caterwaul()ed functions would have access to it.)

// You can also define conditional macros, though they will probably be slower. For example:

// | caterwaul(function () {
//     caterwaul.rmacro(qs[let (_) in _], fn[bs, e][bs.data === '=' && ...]);
//   }) ();

// Here, returning a falsy value indicates that nothing should be changed about this syntax tree. It is replaced by itself and processing continues normally. You should try to express things in
// terms of patterns; there are theoretical optimizations that can cut the average-case runtime of pattern matching to a fraction of a full linear scan. The worst possible case is when you match
// on a universal pattern and restrict later:

// | caterwaul(function () {
//     caterwaul.rmacro(qs[_], fn[x][...]);
//   }) ();

// This will call your macroexpander once for every node in the syntax tree, which for large progams is costly. If you really do have such a variant structure, your best bet is to define separate
// macros, one for each case:

// | caterwaul(function () {
//     var patterns = [qs[foo], qs[bar], qs[bif]];
//     patterns.map (function (p) {
//       caterwaul.rmacro (p, fn[x][...]);
//     });
//   }) ();

// This gives Caterwaul the opportunity to call your function only on relevant nodes. (Note that at present I haven't found an algorithm to make things any faster than using a depth-first scan.
// However, if I do find such an algorithm later on then macroexpansion will run quite a bit faster for programs with well-defined patterns.)

// Pitfalls of macroexpansion.
// Macroexpansion as described here can encode a lambda-calculus. The whole point of having macros is to make them capable, so I can't complain about that. But there are limits to how far I'm
// willing to go down the pattern-matching path. Let's suppose the existence of the let-macro, for instance:

// | let (x = y) in z   ->   (function (x) {return z}) (y)

// If you write these macros:

// | foo[x, y]   ->   let (x = y)
//   bar[x, y]   ->   x in y

// Caterwaul is not required to expand bar[foo[x, y], z] into (function (x) {return z}) (y). It might just leave it at let (x = y) in z instead. The reason is that while the individual
// macroexpansion outputs are macroexpanded, a fixed point is not run on macroexpansion in general. (That would require multiple-indexing, which in my opinion isn't worth the cost.) To get the
// extra macroexpansion you would have to wrap the whole expression in another macro, in this case called 'expand':

// | caterwaul.configure(function () {
//     this.rmacro(expand[_], fn[expression][caterwaul.macroexpand(expression)]);
//   });

// This is an eager macro; by outputting the already-expanded contents, it gets another free pass through the macroexpander.

// Things that are not guaranteed:

// | 1. Reassembly of different pieces (see above)
//   2. Anything at all, if you modify the syntax tree in the macro code. Returning a replacement is one thing, but modifying one will break things.
//   3. Performance bounds.

// Macro vs. rmacro.
// macro() defines a macro whose expansion is left alone. rmacro(), on the other hand, will macroexpand the expansion, letting you emit macro-forms such as fn[][]. Most of the time you will want
// to use rmacro(), but if you want to have a literal[] macro, for instance, you would use macro():

// | caterwaul.configure(function () {
//     // Using macro() instead of rmacro(), so no further expansion:
//     this.macro(qs[literal[_]], fn[x][x]);
//   });

// While macro() is marginally faster than rmacro(), the difference isn't significant in most cases.

//   Matching.
//   macro_try_match returns null if two syntax trees don't match, or a possibly empty array of wildcards if the given tree matches the pattern. Wildcards are indicated by '_' nodes, as
//   illustrated in the macro definition examples earlier in this section. Note that this function is O(n) in the number of nodes in the pattern. It is optimized, though, to reject invalid nodes
//   quickly -- that is, if there is any mismatch in arity or data.

      macro_try_match = function (pattern, t) {if (pattern.data === '_')                                   return [t];
                                               if (pattern.data !== t.data || pattern.length !== t.length) return null;
                                               for (var i = 0, l = pattern.length, wildcards = [], match = null; i < l; ++i)
                                                 if (match = macro_try_match(pattern[i], t[i])) wildcards = wildcards.concat(match);
                                                 else                                           return null;
                                               return wildcards},

//   Expansion.
//   Uses the straightforward brute-force algorithm to go through the source tree and expand macros. At first I tried to use indexes, but found that I couldn't think of a particularly good way to
//   avoid double-expansion -- that is, problems like qs[qs[foo]] -- the outer must be expanded without the inner one. Most indexing strategies would not reliably (or if reliably, not profitably)
//   index the tree in such a way as to encode containment. Perhaps at some point I'll find a faster macroexpander, especially if this one proves to be slow. At this point macroexpansion is by
//   far the most complex part of this system, at O(nki) where n is the number of parse tree nodes, k is the number of macros, and i is the number of nodes in the macro pattern tree. (Though in
//   practice it's generally not quite so bad.)
//   
//   Note! This function by default does not re-macroexpand the output of macros. That is handled at a higher level by Caterwaul's macro definition facility (see the 'rmacro' method).

//   The fourth parameter, 'context', is used to hand a 'this' reference to the macroexpander. This is necessary to get defmacro[] to work properly, and in general lets macros be side-effectful.
//   (Not that you should be in the habit of defining side-effectful macros, but I certainly won't stop you.)

         macro_expand = function (t, macros, expanders, context) {
                          return t.rmap (function (n) {for (var i = 0, l = macros.length, macro = null, match = null, replacement = null; i < l && (macro = macros[i]); ++i)
                                                         if ((match = macro_try_match(macro, n)) && (replacement = expanders[i].apply(context, match))) return replacement})},

// Environment-dependent compilation.
// It's possible to bind variables from 'here' (i.e. this runtime environment) inside a compiled function. The way we do it is to create a closure using a gensym. (Another reason that gensyms
// must really be unique.) Here's the idea. We use the Function constructor to create a shell function that takes a single parameter and returns an inner expression representing the tree that
// we're compiling. That tree will be rewritten to refer to gensyms instead of the symbols that are to be replaced. We then immediately call that function on the hash of name -> value bindings,
// and the new values will be inserted into the inner function by a closure. To make it concrete, we're basically doing this:

// | compile = function (tree, environment) {
//     var bindings_gensym = gensym(),
//         outer_function  = new Function (bindings_gensym, 'return ' + tree.find_each_key_in(environment).and_replace_with(parse('(' + bindings_gensym + '.' + the_key + ')')));
//     return outer_function(bindings_gensym);
//   };

// I was originally going to use a bunch of 'var' declarations to cache the hash keys, but it's actually useful to leave it as a hash reference. The reason is that sometimes you want multiple
// closures in the same environment to communicate with one another. For example, you might have a function that modifies a value and another function that should receive those modifications. In
// that case, you'd want to say this:

// | var f1 = compile(tree1, env),
//       f2 = compile(tree2, env);

// This makes environments mutable and stateful, just like variables normally are in JavaScript. It's debatable whether this is a feature or a repetition of a JavaScript flaw, but I'm going to
// preserve JavaScript's behavior to keep things predictable (or unpredictable, depending on how you look at it).

//   Complications of rewriting.
//   We rewrite the function to use hashtable references instead of variables, but this isn't always a valid transformation. Consider, for instance, what happens when we use the environment {foo:
//   'bar'} on this function:

//   | function () {
//       var bif = foo;
//       var baz = (function (foo) {return foo}) (bif);
//       return foo + baz;
//     }

//   Taking a naive, 'replace-everything' approach would yield this (using simplified gensym notation):

//   | (function (gensym) {
//       return function () {
//         var bif = gensym.foo;
//         var baz = (function (gensym.foo) {return gensym.foo}) (bif);
//         return foo + baz;
//       };
//     }) ({foo: 'bar'})

//   There are a couple of problems that need to be solved. First, we need to recognize variable bindings -- which is possible, since the code has presumably already been macro-expanded
//   (otherwise all bets are off). Second, we also need to know the extent of each of those bindings so that we don't replace a bound variable. Going back to our example, here's the code that
//   should be produced, and the things we need to know to produce it:

//   | (function (gensym) {
//       return function () {
//         var bif = gensym.foo;           // referring to the global foo
//         var baz = (function (foo) {     // foo is bound here
//           return foo;                   // referring to the bound foo
//         }) (bif);
//         return gensym.foo + baz;        // referring to the global foo
//       };
//     }) ({foo: 'bar'})

//   There is a pathological case that V8 (and I) both choose to ignore. Suppose you have a setup like this:

//   | var x = 0;
//     var f = function (y) {
//       if (y & 1) var x;
//       x = y;
//     };
//     f(2);
//     x           // what should this be?

//   It turns out that if you run this in node.js you (somewhat appropriately) get 0, even though the 'var' statement was never evaluated. Caterwaul follows the same rule: 'var' statements don't
//   have to be evaluated in order to modify the scope.

//   Incidentally, if you have a function that uses 'eval', your code might break; for instance, evaluating this function with the environment {r: 10}:

//   | function () {
//       eval('var r = 5');
//       return r;
//     }

//   This function, when mapped into a new environment, always returns 10. The reason is that the 'return r' statement will be rewritten as 'return gensym.r', whereas the eval() won't have its
//   code transformed. (It is technically possible to detect calls to eval() and transform their code accordingly, since eval() is dynamically scoped and you can't call it under a different name.
//   I'm not going to go to the trouble, though.)

  compile = function (tree, environment) {var s = gensym();
                                          return (new Function(s, 'return (' + tree.rmap(function (n) {
                                            return has(environment, n.data) && new syntax_node('(', new syntax_node('.', new syntax_node(s), n))}).serialize() + ')'))(environment)},

// Configurations.
// Caterwaul is stateful in some ways, most particularly with macro definitions and compiler options. To prevent you from having to modify the global caterwaul() function, I've enabled
// replication. This works by giving you access to copies of caterwaul() (and copies of those copies, if you so choose) that you can customize independently. So, for example:

// | var copy = caterwaul.clone (function () {
//     // This function is for customizations. Totally optional; can also customize at the toplevel.
//     this.macro(qs[foo], fn_[qs[bar]]);
//   });

// | copy(function () {
//     var bar = 6;
//     return foo;
//   }) ();                // returns 6

// Related to this is a configure() method that modifies and returns the original function:

// | caterwaul.configure (function () {
//     // Global configuration using 'this'
//   });

//   Attributes and methods.
//   Function copying doesn't involve copying over every attribute indiscriminately, since different behaviors are required for different properties. For example, the macro table should be copied
//   so that clones append to their local copies, methods should be rebound to the new function, and some attributes should just be referenced. These behaviors are encoded by way of an attribute
//   table that keeps track of what to do with each. Attributes show up in this table when you call one of the attribute-association methods:

//   | .ref('attribute', value)            Creates a reference-copying attribute. No copying is done at all; the attribute is cross-referenced between copies of the Caterwaul function.
//     .shallow('attribute', value)        Creates an attribute whose value is copied shallowly; for hashes or arrays.
//     .method('name', f)                  Creates a method bound to the Caterwaul function. f will be bound to any copies on those copies.

//   Naturally, attributes that don't appear in the table are left alone. You can add more of these attribute behaviors using the behavior() method:

//   | .behavior('name', definition)       Creates a new attribute behavior. definition() should take an original attribute value and return a new one, where 'this' is the new Caterwaul function.

//   Underlying this mechanism is the associate() method:

//   | .associate('attribute', 'behavior', value)          Creates an attribute with the given behavior and assigns it a value.

//   A couple of notes. First, these functions are bound to the function they modify; that is, you can eta-reduce them freely. Second, this is not a general purpose function replicator. All of
//   the functions returned here call their own init() method rather than sharing a function body somewhere. (To be fair, the init() method gets referenced -- so it's almost as good I suppose.) A
//   general-purpose way to do this would be to have g call f instead of g.init in the copy_of() function below. I'm not doing this in order to save stack frames; I want the function call
//   performance to be constant-time in the number of copies.

//   Another thing to be aware of is that this isn't a general-purpose metaclassing framework. I made a compromise by discouraging side-effecting initialization in the behavior-association
//   methods -- these should just copy things, reference them, or transform them in some nondestructive way. This makes it easier to have extensional copies of objects, since there are fewer
//   unknowns about the internal state. (e.g. we know that if 'foo' appears in the attribute table, we'll have something called 'foo' on the object itself and we can call its behavior -- we don't
//   have to wonder about anything else.)

  associator_for = function (f) {return function (name, behavior, value) {return f[name] = (f.behaviors[f.attributes[name] = behavior] || id).call(f, value), f}},
    shallow_copy = function (x) {return x && (x.constructor === Array ? Array.prototype.slice.call(x) : merge({}, x))},
         copy_of = function (f) {var g = merge(function () {return g.init.apply(g, arguments)}, {behaviors: shallow_copy(f.behaviors), attributes: {}});
                                 return se(g, function (g) {(g.associate = associator_for(g))('behavior', 'method', function (name, definition) {
                                                              this.behaviors[name] = definition;
                                                              return this.associate(name, 'method', function (attribute, value) {
                                                                return this.associate(attribute, name, value)})}).
                                                            behavior('method', g.behaviors.method);
                                                            for (var k in f.attributes) has(f.attributes, k) && g.associate(k, f.attributes[k], f[k])})};

  return this.caterwaul = merge(copy_of({behaviors: {method: function (v) {return bind(v, this)}}}), {deglobalize: function () {_global.caterwaul = _caterwaul; return this}}).

//   Bootstrapping method behavior.
//   Setting up the behavior(), method(), ref(), and shallow() methods. The behavior() and method() methods are codependent and are initialized in the copy_of function above, whereas the ref()
//   and shallow() methods are not core and are defined here. I'm also defining a 'configuration' function to allow quick definition of new configurations. (These are loadable by their names when
//   calling clone() or configure() -- see 'Standard library' below.) A complement method, 'tconfiguration', is also available. This transforms the configuration function before storing it in the
//   table, enabling you to use things like 'qs[]' without manually transforming stuff. The downside is that you lose closure state and can't bind variables.

    behavior('ref').behavior('shallow', shallow_copy).method('configuration',  function          (name, f) {this.configurations[name] = f; return this}).
                                                      method('tconfiguration', function (configs, name, f) {this.configurations[name] = this.clone.apply(this, configs.split(/\s+/))(f);
                                                                                                            return this}).

// Global Caterwaul setup.
// Now that we've defined lexing, parsing, and macroexpansion, we can create a global Caterwaul function that has the appropriate attributes.

    shallow('compiler', {qs: parse('qs[_]'), expand_qs: false}).shallow('macro_patterns', []).shallow('macro_expanders', []).shallow('configurations', {}).shallow('has', {}).
        ref('syntax', syntax_node).ref('parse', parse).ref('compile', compile).ref('gensym', gensym).ref('map', map).ref('self', self).

     method('reinitialize', fn('$1 = $0(@self), $1($1).deglobalize()')). method('decompile', fn('@parse($0.toString())')).
     method('expand',       fn('@expand_qs(@macroexpand($0))')).         method('macro',     fn('@macro_patterns.push($0), @macro_expanders.push($1), this')).

     method('rmacro', function (pattern, expander) {return this.macro(pattern, bind(function () {var t = expander.apply(this, arguments); return t && this.macroexpand(t)}, this))}).
     method('init',   function       (bindings, f) {var expansion = this.expand(this.decompile(f || bindings)); return compile(expansion.tree, merge(expansion.environment, f ? bindings : {}))}).

     method('macroexpand', function (t) {return macro_expand(t, this.macro_patterns, this.macro_expanders, this)}).
     method('expand_qs',   function (t) {if (! this.compiler.expand_qs) return {environment: {}, tree: t};
                                         var environment = {}, quote_function = function (tree) {return se(gensym(), function (s) {environment[s] = tree; return new syntax_node(s)})};
                                         return {environment: environment, tree: macro_expand(t, [this.compiler.qs], [quote_function], this)}}).

// Utility library.
// Caterwaul uses and provides some design-pattern libraries to encourage extension consistency. This is not entirely selfless on my part; configuration functions have no access to the variables
// I've defined above, since the third-party ones are defined outside of the Caterwaul main function. So anything that they need access to must be accessible on the Caterwaul function that is
// being configured; thus a 'util' object that contains some useful stuff. For starters it contains some general-purpose methods:

    shallow('util', {extend: extend, merge: merge, se: se, macro_try_match: macro_try_match, id: id, bind: bind, map: map,

// It also has some design patterns that are useful for heavyweight (i.e. configurable) extensions.

//   The 'configurable' design pattern.
//   jQuery provides a great manipulation interface; getters and setters have the same names, and absence of a parameter to the method indicates that it's a getter. I'm shamelessly copying that
//   pattern here, except that the state is also made available in an 'options' object, in case you need to peruse it directly. (Usual caveats about public data apply, of course -- use at your
//   own peril. :) )

//   So if you mark an object as being 'configurable', then it will get a bunch of standard-form getter/setter methods and an 'options' hash if one doesn't exist already. The format for saying
//   that an object is configurable is:

//   | caterwaul.util.configurable(object, 'option1', 'option2', {option3: function (new_value) {do_something()}, ...})            // Returns object after adding configuration interface

//   All configuration functions are bound to the object, so they can be eta-reduced freely.

    configurable: function (object) {var function_for = function (name, change) {return function (x) {if (x === undefined) return this.options[name];
                                                                                                      else                 return this.options[name] = (change || id)(x), this}};
                                     object.options || (object.options = {});
                                     for (var i = 1, l = arguments.length, _; _ = arguments[i], i < l; ++i)
                                       if (_.constructor === String) object[_] = bind(function_for(_), object);
                                       else                          for (var k in _) if (_.hasOwnProperty(k)) object[k] = bind(function_for(k, _[k]), object);
                                     return object}}).

// Standard library.
// Caterwaul ships with a standard library of useful macros, though they aren't activated by default. To activate them, you say something like this:

// | caterwaul.configure('fn');
//   // Longhand access to the function:
//   caterwaul.configurations.fn

// You can also pass these libraries into a clone() call:

// | var copy = caterwaul.clone('fn', 'some_other_library', function () {
//     ...
//   });

// Note that functions passed to clone() and configure() are transformed using the existing caterwaul instance. This means that closure state is lost, so configuration at the toplevel is a good
// idea. Named configurations, on the other hand, are not explicitly transformed; so when you define a custom configuration in a named way, you will want to manually transform it. (The reason for
// this is that we don't want to force the configuration author to lose closure state, since it's arguably more important in a library setting than an end-user setting.)

    method('clone',     function () {return arguments.length ? this.clone().configure.apply(null, arguments) : copy_of(this)}).
    method('configure', function () {for (var i = 0, l = arguments.length, _; _ = arguments[i], i < l; ++i) if (_.constructor === String) this.configurations[_].call(this);
                                                                                                            else                          this(_).call(this);                return this}).

//   Qs library.
//   You really need to use this if you're going to write macros. It enables the qs[] construct in your code. This comes by default when you configure with 'std'.

    configuration('qs', function () {this.compiler.expand_qs = true}).

//   Qg library.
//   The qg[] construct seems useless; all it does is parenthesize things. The reason it's there is to overcome constant-folding and rewriting JavaScript runtimes such as SpiderMonkey. Firefox
//   failed the unit tests when ordinary parentheses were used because it requires disambiguation for expression-mode functions only at the statement level; thus syntax trees are not fully mobile
//   like they are ordinarily.

    tconfiguration('qs', 'qg', function () {this.rmacro(qs[qg[_]], function (expression) {return new this.syntax('(', expression)})}).

//   Function abbreviations (the 'fn' library).
//   There are several shorthands that are useful for functions. fn[x, y, z][e] is the same as function (x, y, z) {return e}, fn_[e] constructs a nullary function returning e. Also includes
//   forms for defining local variables. One is 'let [bindings] in expression', and the other is 'expression, where[bindings]'. For the second, keep in mind that comma is left-associative. This
//   means that you'll get the whole comma-expression placed inside a function, rendering it useless for expressions inside procedure calls. (You'll need parens for that.)


    tconfiguration('qs qg', 'fn', function () {this.rmacro(qs[fn[_][_]],     function (vars, expression) {return qs[qg[function (_) {return _}]].s('_', [vars, expression])}).
                                                    rmacro(qs[fn_[_]],       function       (expression) {return qs[qg[function  () {return _}]].s('_', [expression])}).
                                                    rmacro(qs[let[_] in _],  function (vars, expression) {if (vars.data === ',') vars = vars.flatten();
                                                                                                          return qs[fn[_][_].call(this, _)].s('_', [
                                                                                                            vars.data === ',' ? vars.map(function (n) {return n[0]}) : vars[0], expression,
                                                                                                            vars.data === ',' ? vars.map(function (n) {return n[1]}) : vars[1]])}).
                                                    rmacro(qs[_, where[_]],  function (expression, vars) {return qs[(let[_] in qg[_])].s('_', [vars, expression])}).

                                                    rmacro(qs[_, when[_]],   function (expression, cond) {return qs[qg[_] && qg[_]].s('_', [cond, expression])}).
                                                    rmacro(qs[_, unless[_]], function (expression, cond) {return qs[qg[_] || qg[_]].s('_', [cond, expression])})}).

//   Macro authoring tools (the 'defmacro' library).
//   Lisp provides some handy macros for macro authors, including things like (with-gensyms (...) ...) and even (defmacro ...). Writing defmacro is simple because 'this' inside a macroexpander
//   refers to the caterwaul function that is running. It is trivial to expand into 'null' and side-effectfully define a new macro on that caterwaul object.

//   Another handy macro is 'with_gensyms', which lets you write hygienic macros. For example:

//   | defmacro[forEach[_][_]][fn[xs, f][with_gensyms[i, l, xs][(function() {for (var i = 0, xs = _, l = xs.length, it; it = xs[i], it < l; ++it) {_}})()].s('_', [xs, f])]];

//   This will prevent 'xs', 'l', and 'i' from being visible; here is a sample (truncated) macroexpansion:

//   | forEach[[1, 2, 3]][console.log(it)]   ->  (function() {for (var _gensym_gesr8o7u_10fo11_ = 0, _gensym_gesr8o7u_10fo12_ = [1, 2, 3],
//                                                                     _gensym_gesr8o7u_10fo13_ = _gensym_gesr8o7u_10fo12_.length, it;
//                                                                 it = _gensym_gesr8o7u_10fo12_[_gensym_...], _gensym_... < ...; ...) {console.log(it)}})()

//   Since nobody in their right mind would name a variable _gensym_gesr8o7u_10fo11_, it is effectively collision-proof. (Also, even if you load Caterwaul twice you aren't likely to have gensym
//   collisions. The probability of it is one-in-several-billion at least.)

//   Note that macros defined with 'defmacro' are persistent; they outlast the function they were defined in. Presently there is no way to define scoped macros.

    tconfiguration('qs fn', 'defmacro', function () {this.rmacro(qs[defmacro[_][_]],  fn[pattern, expansion][let[expanded = this.expand(expansion)] in
                                                                                                             (this.rmacro(pattern, this.compile(expanded.tree, expanded.environment)), qs[null])]).
                                                          rmacro(qs[with_gensyms[_][_]], fn[vars, expansion][vars.data !== ',' ?
                                                                                                               expansion.s(vars.data, new this.syntax(this.gensym())) :
                                                                                                               vars.flatten().each(fn[v][expansion = expansion.s(v.data, new s(g()))]),
                                                                                                             qs[qs[_]].s('_', expansion), where[g = this.gensym, s = this.syntax]])}).

//   Divergence function syntax.
//   Rebase provides an infix function operator >$> that can be more readable, if more ambiguous, then Caterwaul's fn[][]. Enabling this configuration enables this notation from within Caterwaul.

    tconfiguration('qs qg fn', 'dfn', function () {this.rmacro(qs[_ >$> _], fn[vars, expansion][qs[qg[function (_) {return _}]].s('_', [vars.data === '(' ? vars[0] : vars, expansion])])}).

//   String interpolation.
//   Rebase provides interpolation of #{} groups inside strings. Caterwaul can do the same using a similar rewrite technique that enables macroexpansion inside #{} groups. It generates a syntax
//   tree of the form (+ 'string' (expression) 'string' (expression) ... 'string') -- that is, a flattened variadic +. Strings that do not contain #{} groups are returned as-is.

//   There is some weird stuff going on with splitting and bounds here. Most of it is IE6-related workarounds; IE6 has a buggy implementation of split() that fails to return elements inside match
//   groups. It also fails to return leading and trailing zero-length strings (so, for example, splitting ':foo:bar:bif:' on /:/ would give ['foo', 'bar', 'bif'] in IE, vs. ['', 'foo', 'bar',
//   'bif', ''] in sensible browsers). So there is a certain amount of hackery that happens to make sure that where there are too few strings empty ones get inserted, etc.

//   Another thing that has to happen is that we need to take care of any backslash-quote sequences in the expanded source. The reason is that while generally it's safe to assume that the user
//   didn't put any in, Firefox rewrites strings to be double-quoted, escaping any double-quotes in the process. So in this case we need to find \" and replace them with ".

    tconfiguration('qs', 'string', function () {this.rmacro(qs[_], function (s) {
                                                if (! s.is_string() || ! /#\{[^\}]+\}/.test(s.data)) return false;
                                                var q = s.data.charAt(0), s = s.as_escaped_string(), eq = new RegExp('\\\\' + q, 'g'), strings = s.split(/#\{[^\}]+\}/), xs = [],
                                                                     result = new this.syntax('+');
                                                s.replace(/#\{([^\}]+)\}/g, function (_, s) {xs.push(s)});
                                                for (var i = 0, l = xs.length; i < l; ++i) result.push(new this.syntax(q + (i < strings.length ? strings[i] : '') + q)).
                                                                                                  push(new this.syntax('(', this.parse(xs[i].replace(eq, q))));
                                                return new this.syntax('(', result.push(new this.syntax(q + (xs.length < strings.length ? strings[strings.length - 1] : '') + q)))})}).

//   Standard configuration.
//   This loads all of the production-use extensions.

    configuration('std', function () {this.configure('qs', 'fn', 'dfn', 'defmacro', 'string')})});

// Generated by SDoc 