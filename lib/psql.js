var _ = require('underscore');
var QueryWrapper = require('./query_wrapper');
var step = require('step');
var pg = require('pg');//.native; // disabled for now due to: https://github.com/brianc/node-postgres/issues/48

// Workaround for https://github.com/Vizzuality/CartoDB-SQL-API/issues/100
var types = pg.types;
var arrayParser = require('pg/lib/types/arrayParser');
var floatParser = function(val) {
    return parseFloat(val);
};
var floatArrayParser = function(val) {
    if(!val) { return null; }
    var p = arrayParser.create(val, function(entry) {
        return floatParser(entry);
    });
    return p.parse();
};
types.setTypeParser(20, floatParser); // int8
types.setTypeParser(700, floatParser); // float4
types.setTypeParser(701, floatParser); // float8
types.setTypeParser(1700, floatParser); // numeric
types.setTypeParser(1021, floatArrayParser); // _float4
types.setTypeParser(1022, floatArrayParser); // _float8
types.setTypeParser(1231, floatArrayParser); // _numeric
types.setTypeParser(1016, floatArrayParser); // _int8

// Standard type->name mappnig (up to oid=2000)
var stdTypeName = {
    16: 'bool',
    17: 'bytea',
    20: 'int8',
    21: 'int2',
    23: 'int4',
    25: 'text',
    26: 'oid',
    114: 'JSON',
    700: 'float4',
    701: 'float8',
    1000: '_bool',
    1015: '_varchar',
    1042: 'bpchar',
    1043: 'varchar',
    1005: '_int2',
    1007: '_int4',
    1014: '_bpchar',
    1016: '_int8',
    1021: '_float4',
    1022: '_float8',
    1008: '_regproc',
    1009: '_text',
    1082: 'date',
    1114: 'timestamp',
    1182: '_date',
    1184: 'timestampz',
    1186: 'interval',
    1231: '_numeric',
    1700: 'numeric'
};

// Holds a typeId->typeName mapping for each
// database ever connected to
var extTypeName = {};

/**
 * A simple postgres wrapper with logic about username and database to connect
 * - intended for use with pg_bouncer
 * - defaults to connecting with a "READ ONLY" user to given DB if not passed a specific user_id
 *
 * @param {Object} connectionParams Connection param options
 * - user: database username
 * - pass: database user password
 * - host: database host
 * - port: database port
 * - dbname: database name
 * @param {Object} poolParams
 * - size
 * - idleTimeout
 * - reapInterval
 * @returns PSQL
 */
var PSQL = function(connectionParams, poolParams) {

    var me = {
        POOL_DEFAULT_SIZE: 16,
        POOL_DEFAULT_IDLE_TIMEOUT: 3000,
        POOL_DEFAULT_REAP_INTERVAL: 1000
    };

    // default pool params by global settings or default value
    var globalSettings = global.settings || {};
    var _poolParams = {
        size: globalSettings.db_pool_size || me.POOL_DEFAULT_SIZE,
        idleTimeout: globalSettings.db_pool_idleTimeout || me.POOL_DEFAULT_IDLE_TIMEOUT,
        reapInterval: globalSettings.db_pool_reapInterval || me.POOL_DEFAULT_REAP_INTERVAL
    };

    // pool params will have precedence over global or default settings
    poolParams = poolParams || {};
    _poolParams = _.extend(_poolParams, poolParams)

    // Max database connections in the pool
    // Subsequent connections will block waiting for a free slot
    pg.defaults.poolSize = _poolParams.size;

    // Milliseconds of idle time before removing connection from pool
    pg.defaults.poolIdleTimeout = _poolParams.idleTimeout;

    // Frequency to check for idle clients within the pool, ms
    pg.defaults.reapIntervalMillis = _poolParams.reapInterval;

    // Max row size returned by PG stream
    pg.defaults.maxRowSize = globalSettings.db_max_row_size;

    // keep alive configuration
    var keepAliveConfig;

    if (globalSettings.db_keep_alive) {
        keepAliveConfig = _.extend({}, globalSettings.db_keep_alive);
    }

    var error_text = "Incorrect access parameters. If you are accessing via OAuth, please check your tokens are correct. For public users, please ensure your table is published.";
    if ( ! connectionParams || ( !_.isString(connectionParams.user) && !_.isString(connectionParams.dbname))) {
        throw new Error(error_text);
    }

    me.dbopts = connectionParams;

    me.poolParams = _poolParams;

    me.username = function(){
        return this.dbopts.user;
    };

    me.password = function(){
        return this.dbopts.pass;
    };

    me.database = function(){
        return this.dbopts.dbname;
    };

    me.dbhost = function(){
        return this.dbopts.host;
    };

    me.dbport = function(){
        return this.dbopts.port;
    };

    me.conString = "tcp://";
    if (me.username()) {
        me.conString += me.username();
    }
    me.conString += ":";
    if (me.password()) {
        me.conString += me.password();
    }
    me.conString += "@";
    if (me.dbhost()) {
        me.conString += me.dbhost();
    }
    if (me.dbport()) {
        me.conString += ":" + me.dbport();
    }
    me.conString += "/" + me.database();

    me.connectionObject = {
        host: me.dbhost(),
        port: me.dbport(),
        database: me.database(),
        user: me.username(),
        password: me.password(),
        keepAlive: keepAliveConfig,
        ssl: false
    }

    me.getConnectionConfig = function () {
        if (globalSettings.db_use_config_object) {
            return me.connectionObject;
        }
        return me.conString;
    }

    me.dbkey = function(){
        return this.database(); // + ":" + this.dbhost() + ":" + me.dbport();
    };

    me.ensureTypeCache = function(cb) {
        var db = this.dbkey();
        if (extTypeName[db]) {
            return cb();
        }
        this.dbConnect(this.getConnectionConfig(), function(err, client, done) {
            if (err) {
                return cb(err);
            }
            var types = ["'geometry'","'raster'"]; // types of interest
            client.query("SELECT oid, typname FROM pg_type where typname in (" + types.join(',') + ")", function(err,res) {
                done();
                if (err) {
                    return cb(err);
                }
                var cache = {};
                res.rows.map(function(r) {
                    cache[r.oid] = r.typname;
                });
                extTypeName[db] = cache;
                cb();
            });
        });
    };

    // Return type name for a type identifier
    //
    // Possibly returns undefined, for unkonwn (uncached)
    //
    me.typeName = function(typeId) {
        return stdTypeName[typeId] ? stdTypeName[typeId] : extTypeName[this.dbkey()][typeId];
    };

    me.dbConnect = function(conConfig, cb) {
        pg.connect(conConfig, function(err, client, done) {
            if ( err ) {
                console.log("PostgreSQL connection error: " + err + " - connection config: " + conConfig);
                err = new Error("cannot connect to the database");
                err.http_status = 500; // connection errors are internal
            }
            cb(err, client, done);
        });
    };

    me.connect = function(cb){
        var that = this;
        this.ensureTypeCache(function(err) {
            if (err) {
                return cb(err);
            }

            that.dbConnect(that.getConnectionConfig(), cb);
        });
    };

    me.eventedQuery = function(sql, callback){
        var that = this;

        step(
            function(){
                that.sanitize(sql, this);
            },
            function(err, clean){
                if (err) throw err;
                that.connect(this);
            },
            function(err, client, done){
                var next = this;
                if (err) throw err;
                var query = client.query(sql);

                // forward notices to query
                var noticeListener = function() {
                    query.emit('notice', arguments);
                };
                client.on('notice', noticeListener);

                // NOTE: for some obscure reason passing "done" directly
                //       as the listener works but can be slower
                //      (by x2 factor!)
                query.on('end', function() {
                    client.removeListener('notice', noticeListener);
                    done();
                });
                next(null, query, client);
            },
            function(err, query, client) {
                var queryCanceller = function() {
                    pg.cancel(undefined, client, query);
                };
                callback(err, query, queryCanceller);
            }
        );
    };

    me.quoteIdentifier = function(str) {
        return pg.Client.prototype.escapeIdentifier(str);
    };

    me.escapeLiteral = function(s) {
        return pg.Client.prototype.escapeLiteral(str);
    };

    me.query = function(sql, callback, readonly) {
        var that = this;
        var finish;

        step(
            function(){
                that.sanitize(sql, this);
            },
            function(err, clean){
                if (err) throw err;
                that.connect(this);
            },
            function(err, client, done){
                if (err) throw err;
                finish = done;
                if (!!readonly) {
                    sql = 'SET TRANSACTION READ ONLY; ' + sql;
                }
                client.query(sql, this);
            },
            function(err, res){

                // Release client to the pool
                // should this be postponed to after the callback ?
                // NOTE: if we pass a true value to finish() the client
                //       will be removed from the pool.
                //       We don't want this. Not now.
                if ( finish ) finish();

                callback(err, res)
            }
        );
    };

    // throw exception if illegal operations are detected
    // NOTE: this check is weak hack, better database
    //       permissions should be used instead.
    me.sanitize = function(sql, callback){
        // NOTE: illegal table access is checked in main app
        if (sql.match(/^\s+set\s+/i)){
            var error = new SyntaxError("SET command is forbidden");
            error.http_status = 403;
            callback(error);
            return;
        }
        callback(null,true);
    };

    return me;
};


/**
 * Little hack for UI
 * TODO: drop, fix in the UI (it's not documented in doc/API)
 *
 * @param {string} sql
 * @param {number} limit
 * @param {number} offset
 * @returns {string} The wrapped SQL query with the limit window
 */
PSQL.window_sql = function(sql, limit, offset) {
    // keeping it here for backwards compatibility
    return new QueryWrapper(sql).window(limit, offset).query();
};

module.exports = PSQL;
module.exports.QueryWrapper = QueryWrapper;
