'use strict';

var fs = require('fs')
  , os = require('os')
  , Rx = require('rx')
  , RxNode = require('rx-node')
  , randomSketches = require('../../random').randomSketches
  , thousandEmitter = require('../../thousandEmitter')
  , request = require('request')
  , podClaimer = require('../../pod-claimer')
  , lwip = require('lwip')
  , http = require('http')
  ;

var tag = 'API/THOUSAND';

var bufferMap = {};

var saveImageToFile = function(sketch, buffer) {
  var filename = 'thousand-sketch' + sketch.containerId + '.png';
  console.log(tag, 'Saving sketch to file:', filename);
  return Rx.Observable.create(function(observer) {
    var stream = fs.createWriteStream(os.tmpdir() + '/' + filename);
    stream.write(buffer, function(err) {
      if (err) {
        observer.onError(err);
        return;
      }
      stream.end();
      observer.onNext(sketch);
      observer.onCompleted();
    })
  });
}

var sketchPostAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 40
});

var postImageToPod = function(sketch, buffer) {
  if (!sketch.url) {
    console.log(tag, 'POST disabled for this sketch', sketch.uiUrl);
    sketch.url = 'http://1k.jbosskeynote.com' + sketch.uiUrl;
    return Rx.Observable.return(sketch);
  }
  var postUrl = sketch.url + '/doodle?username='+sketch.name+'&cuid='+sketch.cuid+'&submission='+sketch.submissionId;
  console.log(tag, 'POST sketch to url:', postUrl);
  return Rx.Observable.create(function(observer) {
    if (! sketch.url) {
      sketch.url = 'http://1k.jbosskeynote.com' + sketch.uiUrl;
      observer.onNext({msg: 'No pod url, not POSTting'});
      observer.onCompleted();
      return;
    }
    request.post({
      url: postUrl,
      body: buffer,
      timeout: 5000,
      pool: sketchPostAgent
    }, function (err, res, body) {
      if (err) {
        observer.onError({msg: 'Error POSTting sketch to ' + postUrl});
        return;
      };
      if (res && res.statusCode == 200) {
        // console.log('Post complete:', sketch.url);
        if (sketch.errorCount) {
          console.log(tag, 'POST Recovery (#', sketch.errorCount, ') for url:', sketch.url);
          delete(sketch.errorCount);
        } else {
          console.log(tag, 'POST success for url:', sketch.url);
        }
        observer.onNext(res.body);
        observer.onCompleted();
        return;
      } else {
        var msg = res && res.statusCode ? res.statusCode + ': ' : '';
        observer.onError({msg: msg + 'Error POSTting sketch to ' + postUrl});
        return;
      }
    });
  })
  .retryWhen(function(errors) {
    var maxRetries = 5;
    return errors.scan(0, function(errorCount, err) {
      if (errorCount === 0) {
        console.log(tag, err.msg);
      };
      if (err.code && (err.code === 401 || err.code === 403)) {
        console.log(tag, err.code, 'Error', sketch.url);
        errorCount = maxRetries;
        sketch.url = 'http://1k.jbosskeynote.com' + sketch.uiUrl;
        delete(sketch.errorCount);
      } else {
        sketch.errorCount = ++errorCount;
        if (errorCount === maxRetries) {
          var msg = 'Error: too many retries: ' + sketch.url
          console.log(tag, msg);
          sketch.url = 'http://1k.jbosskeynote.com' + sketch.uiUrl;
          delete(sketch.errorCount);
          throw new Error(msg);
        }
      }
      return errorCount;
    })
    .flatMap(function(errorCount) {
      return Rx.Observable.timer(errorCount * 250);
    });
  })
  .catch(Rx.Observable.return(sketch));
};

var processResponse = function(req) {
  return Rx.Observable.create(function(observer) {
    // console.log(tag, 'Processing response');
    var data = new Buffer('');
    req.on('data', function(chunk) {
      data = Buffer.concat([data, chunk]);
    });
    req.on('error', function(err) {
      observer.onError(err);
    });
    req.on('end', function() {
      // console.log(tag, 'Processed response');
      observer.onNext(data);
      observer.onCompleted();
    });
  })
};

var scaleImage = function(buffer) {
  return Rx.Observable.create(function(observer) {
    // console.log(tag, 'Scaling image');
    lwip.open(buffer, 'png', function(err, image) {
      // console.log(tag, 'Buffer open');
      if (err) {
        observer.onError(err);
        return;
      }
      image.contain(150, 150, function(err, image) {
        // console.log(tag, 'Image scaled');
        if (err) {
          observer.onError(err);
          return;
        }
        image.toBuffer('png', function(err, buffer) {
          // console.log(tag, 'Buffer created');
          if (err) {
            observer.onError(err);
            return;
          }
          observer.onNext(buffer);
          observer.onCompleted();
        });
      });
    });

  })
}

module.exports = exports = {
  receiveImage: function(req, res, next) {
    processResponse(req).flatMap(function(buffer) {
      return scaleImage(buffer);
    })
    .flatMap(function(buffer) {
      return podClaimer.getRandomPod.map(function(randomPod) {
        // console.log(tag, 'randomPod', randomPod.id);
        var sketch = {
          containerId: randomPod.id
        , url: randomPod.url
        , uiUrl: '/api/sketch/' + randomPod.id
        , name: req.query.name
        , cuid: req.query.cuid
        , submissionId: req.query.submission_id
        };
        randomPod.skecth = sketch;
        sketch.buffer = buffer;
        return sketch;
      });
    })
    .flatMap(function(sketch) {
      return Rx.Observable.forkJoin(
        saveImageToFile(sketch, sketch.buffer)
      , postImageToPod(sketch, sketch.buffer)
      ).map(function(arr) {
        return arr[0]
      })
    })
    .tap(function(sketch) {
      bufferMap[sketch.containerId] = sketch.buffer;
      delete sketch['buffer'];
    })
    .subscribe(function(sketch) {
      //console.log(tag, 'new sketch', sketch.url, sketch.cuid);
      thousandEmitter.emit('new-sketch', sketch);
      res.json(sketch);
    }, function(err) {
      // delete randomPod.skecth;
      // delete randomPod.claimed;
      console.log(tag, err)
      next(err);
    });
  },

  getImage: function(req, res, next) {
    var containerId = parseInt(req.params.containerId);
    var filename = 'thousand-sketch' + containerId + '.png';
    var buffer = bufferMap[containerId];
    if (buffer) {
      res.send(buffer);
      delete bufferMap[containerId];
    } else {
      fs.createReadStream(os.tmpdir() + '/' + filename, {
        'bufferSize': 4 * 1024
      }).pipe(res);
    };
  },

  removeImage: function(req, res, next) {
    var containerId = req.params.containerId;
    if (containerId === 'all') {
      thousandEmitter.emit('remove-all');
      bufferMap = {};
      res.send('removed all');
    } else {
      containerId = parseInt(containerId);
      delete bufferMap[containerId];
      var filename = 'thousand-sketch' + containerId + '.png';
      thousandEmitter.emit('remove-sketch', containerId);
      fs.createReadStream('./server/thousand/api/thousand/censored.png').pipe(fs.createWriteStream(os.tmpdir() + '/' + filename));
      res.send('removed');
    };
  },

  randomSketches: function(req, res, next) {
    var numSketches = req.params.numSketches;
    randomSketches(numSketches).flatMap(function(sketch) {
      return podClaimer.getRandomPod.map(function(randomPod) {
        sketch.containerId = randomPod.id
        thousandEmitter.emit('new-sketch', sketch);
        return sketch;
      });
    })
    .subscribe(function(sketch) {
    }, function(error) {
      next(error)
    }, function() {
      console.log(tag, numSketches + ' sketches pushed');
      res.json({msg: numSketches + ' sketches pushed'});
    });
  }
};
