import catchAsync from '../utils/catchAsync.js';
import User from '../models/User.js';
import {
  signupValidator,
  loginValidator,
} from '../validation/authValidation.js';
import HTTPError from '../utils/httpError.js';
import jwt from 'jsonwebtoken';
import sendEmail from '../emails/email.js';

const createTokenAndRes = (res, statusCode, data, message) => {
  const token = jwt.sign({ id: data._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIERES_IN,
  });

  res.status(statusCode).json({
    status: 'success',
    token,
    message: message ? message : undefined,
    data: {
      data,
    },
  });
};

const sendEmailVerifyKey = async user => {
  const key = await user.generateEmailVerification();
  const link = `http://localhost/api/v1/users/verifyEmail/:${key}`;
  const html = `
  Please click this <a href="${link}">Link</a> to verify your email address!
  `;

  user.emailVerifyKey = key;
  await user.save({ validateBeforeSave: false });
  await sendEmail({
    email: user.email,
    subject: `This is your verification key to verify your email ${key}`,
    html,
  });
};

export const signup = catchAsync(async (req, res, next) => {
  const { username, email, password, role } = req.body;
  const requestBody = {
    username,
    email,
    password,
    role,
  };

  // validate input data
  const { error } = signupValidator.validate(requestBody);
  if (error) {
    return next(new HTTPError(error.message, 400));
  }
  // create user
  const user = await User.create(requestBody);
  // create email verify code
  if (!error) {
    sendEmailVerifyKey(user);
  }

  res.status(201).json({
    status: 'success',
    message: `Sent an email to ${user.email}`,
  });
});

export const verifyEmail = catchAsync(async (req, res, next) => {
  // get user based on verifyemail
  const user = await User.findOne({ emailVerifyKey: req.params.key });

  user.verified = true;
  user.emailVerifyKey = undefined;
  await user.save({ validateBeforeSave: false });

  createTokenAndRes(res, 200, user);
});

export const login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  // const { error } = validateUser.validate({ email, password });
  const { error } = loginValidator.validate({ email, password });

  if (error) {
    return next(new HTTPError(error.message, 400));
  }

  // chek the user still exists
  const user = await User.findOne({ email: email }).select('+password');
  if (!user || !user.correctPassword(password, user.password))
    return next(new HTTPError('Incorrect email or password!', 401));

  req.user = user;
  createTokenAndRes(res, 200, user);
});

export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new HTTPError('You do not at premission to performe this action', 403),
      );
    }
    next();
  };
};

export const forgetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new HTTPError('There is no user with email address.', 404));
  }

  // 2) Generate the random reset token
  const resetToken = user.createresetPasswordToken();
  await user.save({ validateBeforeSave: false });

  // 3) Send it to user's email
  const resetURL = `${req.protocol}://${req.get(
    'host',
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}.\nIf you didn't forget your password, please ignore this email!`;

  try {
    await sendEmail({
      email: user.email,
      subject: 'Your password reset token (valid for 10 min)',
      message,
    });

    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(
      new HTTPError('There was an error sending the email. Try again later!'),
      500,
    );
  }
});

export const resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const user = await User.findOne({
    passwordResetToken: req.params.token,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) If token has not expired, and there is user, set the new password
  if (!user) {
    return next(new HTTPError('Invalid or expired token!', 400));
  }

  if (!req.body.password) {
    return next(new HTTPError('Please provide a new password!', 400));
  }

  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.password = req.body.password;

  await user.save();

  createTokenAndRes(res, 200, user);
});