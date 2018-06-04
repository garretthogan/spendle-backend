const serverEnv = process.env.IS_LOCAL === 'true' ? require('./.env.json') : process.env;
const fb_graph_url = 'https://graph.facebook.com';
const fetch = require('node-fetch');
const plaid = require('plaid');
const moment = require('moment');
const cors = require('cors');
const bodyParser = require('body-parser');
const express = require('express');
const app = express();

const AWS = require('aws-sdk');
AWS.config.update({
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || serverEnv.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || serverEnv.AWS_SECRET_ACCESS_KEY,
});

const dyanmoDb = new AWS.DynamoDB({apiVersion: '2012-08-10'});
const tableName = process.env.NODE_ENV === 'production' ? 'spendle-user-data' : 'spendle-user-data-test';

const envs = {
  'development': plaid.environments.sandbox,
  'production': plaid.environments.development,
};
const plaidEnv = envs[process.env.NODE_ENV];
const plaidClient = new plaid.Client(
  serverEnv.CLIENT_ID,
  serverEnv.SECRET,
  serverEnv.PUBLIC_KEY,
  plaidEnv,
);

app.use(bodyParser.urlencoded({
  extended: false,
}));
app.use(bodyParser.json());

function validateToken (token) {
  return fetch(`${fb_graph_url}/debug_token?input_token=${token}&access_token=${serverEnv.FB_APP_TOKEN}`)
    .then(res => res.json())
    .then((verifyResponse) => {
      return verifyResponse.data.is_valid;
    })
    .catch(error => error);
}

app.options('/user/:userId', cors());
app.get('/user/:userId', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  const userId = request.params.userId;
  const testToken = request.query.token;
  const params = {
    TableName: tableName,
    Key: {
      'userId': {
        S: request.params.userId
      }
    }
  };
  validateToken(testToken).then((isValid) => {
    if(isValid) {
      dyanmoDb.getItem(params).promise().then((data) => {
        if (Object.keys(data).length < 1) {
          response.send(JSON.stringify({userExists: false}));
        } else {
          const user = {
            userExists: true,
            incomeAfterBills: data.Item.incomeAfterBills.N,
            phoneNumber: data.Item.phoneNumber.N,
            targetSavingsPercentage: data.Item.targetSavingsPercentage.N,
            plaidAccessToken: data.Item.plaidAccessToken.S,
            userId: data.Item.userId.S
          }
          response.send(JSON.stringify(user));
        }
      }).catch(error => response.send(JSON.stringify(error)));
    } else {
      response.send(JSON.stringify({message: 'INVALID TOKEN'}));
    }
  }).catch(error => response.send(JSON.stringify(error)));
});

app.delete('/user/:userId', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  const userId = request.params.userId;
  const testToken = request.query.token;
  const params = {
    TableName: tableName,
    Key: {
      'userId': {
        S: request.params.userId
      }
    }
  };

  validateToken(testToken).then((isValid) => {
    if(isValid) {
      dyanmoDb.deleteItem(params).promise().then((data) => {
        response.send(JSON.stringify(data));
        return;
      }).catch(error => response.send(JSON.stringify(error)));
    } else {
      response.send(JSON.stringify({message: 'INVALID TOKEN'}));
      return;
    }
  }).catch(error => response.send(JSON.stringify(error)));
});

// validate fb token here too
app.options('/save_budget', cors());
app.post('/save_budget', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  const testToken = request.body.token;

  validateToken(testToken).then(isValid => {
    if(isValid) {
      const incomeAfterBills = request.body.incomeAfterBills;
      const phoneNumber = request.body.phoneNumber;
      const targetSavingsPercentage = request.body.targetSavingsPercentage;
      const userId = request.body.userId;
      const plaidAccessToken = request.body.accessToken;

      const params = {
        TableName: tableName,
        Item: {
          'userId': {
            S: userId
          },
          'targetSavingsPercentage': {
            N: `${targetSavingsPercentage}`
          },
          'incomeAfterBills': {
            N: `${incomeAfterBills}`
          },
          'phoneNumber': {
            N: `${phoneNumber}`
          },
          'plaidAccessToken': {
            S: `${plaidAccessToken}`
          }
        }
      };
    
      dyanmoDb.putItem(params, (error, data) => {
        if(error) {
          response.send(JSON.stringify(error));
          return;
        }
        response.send(JSON.stringify({message: 'Budget saved!'}));
      });
    } else {
      response.send(JSON.stringify({message: 'INVALID TOKEN'}));
    }
  });
});

app.get('/public_key', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Content-Type', 'application/json');
  validateToken(request.query.fbAccessToken).then(isValid => {
    if (isValid) {
      response.send(JSON.stringify({public_key: process.env.PUBLIC_KEY || serverEnv.PUBLIC_KEY}));
    } else {
      response.send(JSON.stringify({message: 'INVALID TOKEN'}));
    }
  });
});

app.options('/get_access_token', cors());
app.post('/get_access_token', function(request, response, next) {
  const PUBLIC_TOKEN = request.body.public_token;
  response.setHeader('Access-Control-Allow-Origin', '*');
  plaidClient.exchangePublicToken(PUBLIC_TOKEN, function(error, tokenResponse) {
    if (error != null) {
      var msg = 'Could not exchange public_token!';
      console.log(msg + '\n' + JSON.stringify(error));
      return response.send(JSON.stringify({
        error: msg
      }));
    }
    response.send(JSON.stringify({
      item_id: tokenResponse.item_id,
      access_token: tokenResponse.access_token,
    }));
  });
});

app.get('/accounts', function(request, response, next) {
  // Retrieve high-level account information and account and routing numbers
  // for each account associated with the Item.
  plaidClient.getAuth(ACCESS_TOKEN, function(error, authResponse) {
    if (error != null) {
      var msg = 'Unable to pull accounts from the Plaid API.';
      console.log(msg + '\n' + error);
      return response.json({
        error: msg
      });
    }

    console.log(authResponse.accounts);
    response.json({
      error: false,
      accounts: authResponse.accounts,
      numbers: authResponse.numbers,
    });
  });
});

app.options('/item', cors());
app.post('/item', function(request, response, next) {
  // Pull the Item - this includes information about available products,
  // billed products, webhook information, and more.
  plaidClient.getItem(ACCESS_TOKEN, function(error, itemResponse) {
    if (error != null) {
      console.log(JSON.stringify(error));
      return response.json({
        error: error
      });
    }

    // Also pull information about the institution
    plaidClient.getInstitutionById(itemResponse.item.institution_id, function(err, instRes) {
      if (err != null) {
        var msg = 'Unable to pull institution information from the Plaid API.';
        console.log(msg + '\n' + error);
        return response.json({
          error: msg
        });
      } else {
        response.json({
          item: itemResponse.item,
          institution: instRes.institution,
        });
      }
    });
  });
});

app.options('/transactions', cors());
app.post('/transactions', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  // Pull transactions for the Item for the last 30 days
  var startDate = moment(request.body.start_date).format('YYYY-MM-DD');
  var endDate = moment(request.body.end_date).format('YYYY-MM-DD');
  plaidClient.getTransactions(request.body.access_token, startDate, endDate, {
    count: 250,
    offset: 0,
  }, function(error, transactionsResponse) {
    if (error != null) {
      console.log(JSON.stringify(error));
      return response.send(JSON.stringify({
        error: error
      }));
    }
    response.send(JSON.stringify(transactionsResponse.transactions));
  });
});

app.options('/progress_report', cors());
app.post('/progress_report', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  const startDate = moment(request.body.start_date).format('YYYY-MM-DD');
  const endDate = moment(request.body.end_date).format('YYYY-MM-DD');
  const filters = request.body.filters;
  const userId = request.body.user_id;
  const accessToken = request.body.access_token;

  plaidClient.getTransactions(accessToken, startDate, endDate, {
    count: 250,
    offset: 0,
  }, function(error, transactionResponse) {
    if(error != null) {
      console.log(JSON.stringify(error));
      response.send(JSON.stringify(error));
    } else {
      const params = {
        TableName: tableName,
        Key: {
          'userId': {
            S: userId
          }
        }
      };          
      dyanmoDb.getItem(params).promise().then((data) => {
        if (Object.keys(data).length < 1) {
          response.send(JSON.stringify({userExists: false}));
        } else {
          const transactions = transactionResponse.transactions;
          const filtered = transactions.filter((t) => {
            const filteredCategories = t.category.filter(c => filters.some(f => f === c));
            return filteredCategories.length === 0;
          });

          const topTransactions = filtered
            .sort((a, b) => (a.amount < b.amount ? 1 : -1))
            .slice(0, 3)
            .map(t => `$${t.amount} at ${t.name}`);

          // transactions that occured last week
          const filteredLastWeek = filtered.filter((t) => {
            const lastWeekStart = moment().subtract(1, 'week').startOf('week');
            const lastWeekEnd = moment().subtract(1, 'week').endOf('week');
            const transDate = moment(t.date);

            return  (transDate.isSame(lastWeekStart) || transDate.isAfter(lastWeekStart)) &&
                    (transDate.isSame(lastWeekEnd) || transDate.isBefore(lastWeekEnd));
          });

          // transactions that occured yesterday
          const filteredYesterday = filtered.filter((t) => {
            const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');
            const transDate = moment(t.date).format('YYYY-MM-DD');

            return moment(transDate).isSame(yesterday);
          });

          const totalSpent = filtered.length > 0 ? filtered.map(t => t.amount).reduce((prev, current) => prev + current) : 0;
          const spentLastWeek = filteredLastWeek.length > 0 ? filteredLastWeek.map(t => t.amount).reduce((prev, current) => prev + current) : 0;
          const spentYesterday = filteredYesterday.length > 0 ? filteredYesterday.map(t => t.amount).reduce((prev, current) => prev + current) : 0;
          const incomeAfterBills = data.Item.incomeAfterBills.N;
          const targetSavingsPercentage = data.Item.targetSavingsPercentage.N;
          const targetSavings = incomeAfterBills * (targetSavingsPercentage * 0.01);
          const remainingBudget = (incomeAfterBills - targetSavings) - totalSpent;
          const daysRemaining = moment().daysInMonth() - moment().date();
          const dailyBudget = remainingBudget / daysRemaining;

          const report = {
            topTransactions: topTransactions,
            totalSpent: process.env.NODE_ENV === 'production' ? totalSpent : 150,
            spentLastWeek: spentLastWeek,
            spentYesterday: spentYesterday,
            dailyBudget: dailyBudget,
            remainingBudget: remainingBudget,
            targetSavings: targetSavings,
          };
          response.send(JSON.stringify(report));
        }
      }).catch((error) => {
        console.log({error});
        response.send(JSON.stringify(error));
      });
    }
  });

});

app.options('/remove_item', cors());
app.post('/remove_item', function(request, response, next) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  plaidClient.removeItem(request.body.access_token, function(error, itemResponse) {
    if(error != null) {
      console.log(JSON.stringify(error));
      return response.send(JSON.stringify(error));
    }
    response.send(JSON.stringify(itemResponse));
  });
});

app.listen(process.env.PORT || 8000, () => {
  console.log('LISTENING ON ', process.env.PORT || 8000);
});

/**
 * To do
 * - refactor some logic that gets repeated
 * - maybe create some util methods
 */
