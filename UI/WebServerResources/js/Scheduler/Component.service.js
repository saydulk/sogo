/* -*- Mode: javascript; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

(function() {
  'use strict';

  /**
   * @name Component
   * @constructor
   * @param {object} futureComponentData - either an object literal or a promise
   */
  function Component(futureComponentData) {
    // Data is immediately available
    if (typeof futureComponentData.then !== 'function') {
      this.init(futureComponentData);
      if (this.pid && !this.id) {
        // Prepare for the creation of a new component;
        // Get UID from the server.
        var newComponentData = Component.$$resource.newguid(this.pid);
        this.$unwrap(newComponentData);
        this.isNew = true;
      }
    }
    else {
      // The promise will be unwrapped first
      this.$unwrap(futureComponentData);
    }
  }

  /**
   * @memberof Component
   * @desc The factory we'll use to register with Angular
   * @returns the Component constructor
   */
  Component.$factory = ['$q', '$timeout', '$log', 'sgSettings', 'Preferences', 'Gravatar', 'Resource', function($q, $timeout, $log, Settings, Preferences, Gravatar, Resource) {
    angular.extend(Component, {
      $q: $q,
      $timeout: $timeout,
      $log: $log,
      $Preferences: Preferences,
      $gravatar: Gravatar,
      $$resource: new Resource(Settings.baseURL(), Settings.activeUser()),
      timeFormat: "%H:%M",
      // Filter parameters common to events and tasks
      $query: { value: '', search: 'title_Category_Location' },
      // Filter paramaters specific to events
      $queryEvents: { sort: 'start', asc: 1, filterpopup: 'view_next7' },
      // Filter parameters specific to tasks
      $queryTasks: { sort: 'status', asc: 1, filterpopup: 'view_incomplete' },
      $refreshTimeout: null
    });
    Preferences.ready().then(function() {
      // Initialize filter parameters from user's settings
      if (Preferences.settings.Calendar.EventsFilterState)
        Component.$queryEvents.filterpopup = Preferences.settings.Calendar.EventsFilterState;
      if (Preferences.settings.Calendar.TasksFilterState)
        Component.$queryTasks.filterpopup = Preferences.settings.Calendar.TasksFilterState;
      if (Preferences.settings.Calendar.EventsSortingState) {
        Component.$queryEvents.sort = Preferences.settings.Calendar.EventsSortingState[0];
        Component.$queryEvents.asc = parseInt(Preferences.settings.Calendar.EventsSortingState[1]);
      }
      if (Preferences.settings.Calendar.TasksSortingState) {
        Component.$queryTasks.sort = Preferences.settings.Calendar.TasksSortingState[0];
        Component.$queryTasks.asc = parseInt(Preferences.settings.Calendar.TasksSortingState[1]);
      }
      Component.$queryTasks.show_completed = parseInt(Preferences.settings.ShowCompletedTasks);
      // Initialize categories from user's defaults
      Component.$categories = Preferences.defaults.SOGoCalendarCategoriesColors;
      // Initialize time format from user's defaults
      if (Preferences.defaults.SOGoTimeFormat) {
        Component.timeFormat = Preferences.defaults.SOGoTimeFormat;
      }
    });

    return Component; // return constructor
  }];

  /**
   * @module SOGo.SchedulerUI
   * @desc Factory registration of Component in Angular module.
   */
  try {
    angular.module('SOGo.SchedulerUI');
  }
  catch(e) {
    angular.module('SOGo.SchedulerUI', ['SOGo.Common']);
  }
  angular.module('SOGo.SchedulerUI')
    .factory('Component', Component.$factory);

  /**
   * @function $selectedCount
   * @memberof Component
   * @desc Return the number of events or tasks selected by the user.
   * @returns the number of selected events or tasks
   */
  Component.$selectedCount = function() {
    var count;

    count = 0;
    if (Component.$events) {
      count = (_.filter(Component.$events, function(event) { return event.selected; })).length;
    }
    if (Component.$tasks) {
      count = (_.filter(Component.$tasks, function(task) { return task.selected; })).length;
    }
    return count;
  };

  /**
   * @function $startRefreshTimeout
   * @memberof Component
   * @desc Starts the refresh timeout for the current selected component type, for all calendars
   */
  Component.$startRefreshTimeout = function(type) {
    var _this = this;

    if (Component.$refreshTimeout)
      Component.$timeout.cancel(Component.$refreshTimeout);

    Component.$Preferences.ready().then(function() {
      // Restart the refresh timer, if needed
      var refreshViewCheck = Component.$Preferences.defaults.SOGoRefreshViewCheck;
      if (refreshViewCheck && refreshViewCheck != 'manually') {
        var f = angular.bind(_this, Component.$filter, type);
        Component.$refreshTimeout = Component.$timeout(f, refreshViewCheck.timeInterval()*1000);
      }
    });
  };

  /**
   * @function $filter
   * @memberof Component
   * @desc Search for components matching some criterias
   * @param {string} type - either 'events' or 'tasks'
   * @param {object} [options] - additional options to the query
   * @returns a collection of Components instances
   */
  Component.$filter = function(type, options) {
    var _this = this,
        now = new Date(),
        day = now.getDate(),
        month = now.getMonth() + 1,
        year = now.getFullYear(),
        queryKey = '$query' + type.capitalize(),
        params = {
          day: '' + year + (month < 10?'0':'') + month + (day < 10?'0':'') + day,
        };

    Component.$startRefreshTimeout(type);

    return this.$Preferences.ready().then(function() {
      var futureComponentData,
          dirty = false,
          otherType;

      angular.extend(_this.$query, params);

      if (options) {
        _.each(_.keys(options), function(key) {
          // Query parameters common to events and tasks are compared
          dirty |= (_this.$query[key] && options[key] != Component.$query[key]);
          if (key == 'reload' && options[key])
            dirty = true;
          // Update either the common parameters or the type-specific parameters
          else if (angular.isDefined(_this.$query[key]))
            _this.$query[key] = options[key];
          else
            _this[queryKey][key] = options[key];
        });
      }

      // Perform query with both common and type-specific parameters
      futureComponentData = _this.$$resource.fetch(null, type + 'list',
                                                   angular.extend(_this[queryKey], _this.$query));

      // Invalidate cached results of other type if $query has changed
      otherType = (type == 'tasks')? '$events' : '$tasks';
      if (dirty) {
        delete Component[otherType];
        Component.$log.debug('force reload of ' + otherType);
      }

      return _this.$unwrapCollection(type, futureComponentData);
    });
  };

  /**
   * @function $find
   * @desc Fetch a component from a specific calendar.
   * @param {string} calendarId - the calendar ID
   * @param {string} componentId - the component ID
   * @param {string} [occurrenceId] - the component ID
   * @see {@link Calendar.$getComponent}
   */
  Component.$find = function(calendarId, componentId, occurrenceId) {
    var futureComponentData, path = [calendarId, componentId];

    if (occurrenceId)
      path.push(occurrenceId);

    futureComponentData = this.$$resource.fetch(path.join('/'), 'view');

    return new Component(futureComponentData);
  };

  /**
   * @function filterCategories
   * @desc Search for categories matching some criterias
   * @param {string} search - the search string to match
   * @returns a collection of strings
   */
  Component.filterCategories = function(query) {
    var re = new RegExp(query, 'i');
    return _.filter(_.keys(Component.$categories), function(category) {
      return category.search(re) != -1;
    });
  };

  /**
   * @function saveSelectedList
   * @desc Save to the user's settings the currently selected list.
   * @param {string} componentType - either "events" or "tasks"
   * @returns a promise of the HTTP operation
   */
  Component.saveSelectedList = function(componentType) {
    return this.$$resource.post(null, 'saveSelectedList', { list: componentType + 'ListView' });
  };

  /**
   * @function $eventsBlocksForView
   * @desc Events blocks for a specific week
   * @param {string} view - Either 'day' or 'week'
   * @param {Date} type - Date of any day of the desired period
   * @returns a promise of a collection of objects describing the events blocks
   */
  Component.$eventsBlocksForView = function(view, date) {
    var viewAction, startDate, endDate, params;

    if (view == 'day') {
      viewAction = 'dayView';
      startDate = endDate = date;
    }
    else if (view == 'week') {
      viewAction = 'weekView';
      startDate = date.beginOfWeek();
      endDate = new Date();
      endDate.setTime(startDate.getTime());
      endDate.addDays(6);
    }
    else if (view == 'month') {
      viewAction = 'monthView';
      startDate = date;
      startDate.setDate(1);
      startDate = startDate.beginOfWeek();
      endDate = new Date();
      endDate.setTime(startDate.getTime());
      endDate.setMonth(endDate.getMonth() + 1);
      endDate.addDays(-1);
      endDate = endDate.endOfWeek();
    }
    return this.$eventsBlocks(viewAction, startDate, endDate);
  };

  /**
   * @function $eventsBlocks
   * @desc Events blocks for a specific view and period
   * @param {string} view - Either 'day' or 'week'
   * @param {Date} startDate - period's start date
   * @param {Date} endDate - period's end date
   * @returns a promise of a collection of objects describing the events blocks
   */
  Component.$eventsBlocks = function(view, startDate, endDate) {
    var params, futureComponentData, i,
        deferred = Component.$q.defer();

    params = { view: view.toLowerCase(), sd: startDate.getDayString(), ed: endDate.getDayString() };
    Component.$log.debug('eventsblocks ' + JSON.stringify(params, undefined, 2));
    futureComponentData = this.$$resource.fetch(null, 'eventsblocks', params);
    futureComponentData.then(function(data) {
      Component.$timeout(function() {
        var components = [], blocks = {};

        // Instantiate Component objects
        _.reduce(data.events, function(objects, eventData, i) {
          var componentData = _.object(data.eventsFields, eventData),
              start = new Date(componentData.c_startdate * 1000);
          componentData.hour = start.getHourString();
          objects.push(new Component(componentData));
          return objects;
        }, components);

        // Associate Component objects to blocks positions
        _.each(_.flatten(data.blocks), function(block) {
          block.component = components[block.nbr];
        });

        // Convert array of blocks to object with days as keys
        for (i = 0; i < data.blocks.length; i++) {
          blocks[startDate.getDayString()] = data.blocks[i];
          startDate.addDays(1);
        }

        Component.$log.debug('blocks ready (' + _.keys(blocks).length + ')');

        // Save the blocks to the object model
        Component.$blocks = blocks;

        deferred.resolve(blocks);
      });
    }, deferred.reject);

    return deferred.promise;
  };

  /**
   * @function $unwrapCollection
   * @desc Unwrap a promise and instanciate new Component objects using received data.
   * @param {string} type - either 'events' or 'tasks'
   * @param {promise} futureComponentData - a promise of the components' metadata
   * @returns a promise of the HTTP operation
   */
  Component.$unwrapCollection = function(type, futureComponentData) {
    var _this = this,
        components = [];

    return futureComponentData.then(function(data) {
      return Component.$timeout(function() {
        var fields = _.invoke(data.fields, 'toLowerCase');

        // Instanciate Component objects
        _.reduce(data[type], function(components, componentData, i) {
          var data = _.object(fields, componentData);
          components.push(new Component(data));
          return components;
        }, components);

        Component.$log.debug('list of ' + type + ' ready (' + components.length + ')');

        // Save the list of components to the object model
        Component['$' + type] = components;

        return components;
      });
    });
  };

  /**
   * @function init
   * @memberof Component.prototype
   * @desc Extend instance with required attributes and new data.
   * @param {object} data - attributes of component
   */
  Component.prototype.init = function(data) {
    var _this = this;

    this.categories = [];
    this.repeat = {};
    this.alarm = { action: 'display', quantity: 5, unit: 'MINUTES', reference: 'BEFORE', relation: 'START' };
    this.status = 'not-specified';
    angular.extend(this, data);

    Component.$Preferences.ready().then(function() {
      var type = (_this.type == 'appointment')? 'Events' : 'Tasks';

      // Set default values from user's defaults
      _this.classification = _this.classification ||
        Component.$Preferences.defaults['SOGoCalendar' + type + 'DefaultClassification'].toLowerCase();
    });

    if (this.startDate)
      this.start = new Date(this.startDate.substring(0,10) + ' ' + this.startDate.substring(11,16));
    else if (this.type == 'appointment') {
      this.start = new Date();
    }

    if (this.endDate)
      this.end = new Date(this.endDate.substring(0,10) + ' ' + this.endDate.substring(11,16));
    else if (this.type == 'appointment') {
      this.end = new Date();
      this.end.addHours(1);
    }

    if (this.dueDate)
      this.due = new Date(this.dueDate.substring(0,10) + ' ' + this.dueDate.substring(11,16));

    // Parse recurrence rule definition and initialize default values
    this.$isRecurrent = angular.isDefined(data.repeat);
    if (this.repeat.days) {
      var byDayMask = _.find(this.repeat.days, function(o) {
        return angular.isDefined(o.occurrence);
      });
      if (byDayMask)
        if (this.repeat.frequency == 'yearly')
          this.repeat.year = { byday: true };
        this.repeat.month = {
          type: 'byday',
          occurrence: byDayMask.occurrence.toString(),
          day: byDayMask.day
        };
    }
    else {
      this.repeat.days = [];
    }
    if (angular.isUndefined(this.repeat.frequency))
      this.repeat.frequency = 'never';
    if (angular.isUndefined(this.repeat.interval))
      this.repeat.interval = 1;
    if (angular.isUndefined(this.repeat.month))
      this.repeat.month = { occurrence: '1', day: 'SU', type: 'bymonthday' };
    if (angular.isUndefined(this.repeat.monthdays))
      // TODO: initialize this.repeat.monthdays with month day of start date
      this.repeat.monthdays = [];
    if (angular.isUndefined(this.repeat.months))
      // TODO: initialize this.repeat.months with month of start date
      this.repeat.months = [];
    if (angular.isUndefined(this.repeat.year))
      this.repeat.year = {};
    if (this.repeat.count)
      this.repeat.end = 'count';
    else if (this.repeat.until) {
      this.repeat.end = 'until';
      this.repeat.until = this.repeat.until.substring(0,10).asDate();
    }
    else
      this.repeat.end = 'never';
    this.$hasCustomRepeat = this.hasCustomRepeat();

    if (this.isNew) {
      // Set default alarm
      Component.$Preferences.ready().then(function() {
        var units = { M: 'MINUTES', H: 'HOURS', D: 'DAYS', W: 'WEEKS' };
        var match = /-PT?([0-9]+)([MHDW])/.exec(Component.$Preferences.defaults.SOGoCalendarDefaultReminder);
        if (match) {
          _this.$hasAlarm = true;
          _this.alarm.quantity = parseInt(match[1]);
          _this.alarm.unit = units[match[2]];
        }
      });
    }
    else {
      this.$hasAlarm = angular.isDefined(data.alarm);
    }

    // Allow the component to be moved to a different calendar
    this.destinationCalendar = this.pid;

    if (this.organizer && this.organizer.email) {
      this.organizer.$image = Component.$gravatar(this.organizer.email, 32);
    }

    // Load freebusy of attendees
    this.freebusy = this.updateFreeBusyCoverage();

    if (this.attendees) {
      _.each(this.attendees, function(attendee) {
        attendee.image = Component.$gravatar(attendee.email, 32);
        _this.updateFreeBusy(attendee);
      });
    }

    this.selected = false;
  };

  /**
   * @function hasCustomRepeat
   * @memberof Component.prototype
   * @desc Check if the component has a custom recurrence rule.
   * @returns true if the recurrence rule requires the full recurrence editor
   */
  Component.prototype.hasCustomRepeat = function() {
    var b = angular.isDefined(this.repeat) &&
        (this.repeat.interval > 1 ||
         this.repeat.days && this.repeat.days.length > 0 ||
         this.repeat.monthdays && this.repeat.monthdays.length > 0 ||
         this.repeat.months && this.repeat.months.length > 0);
    return b;
  };

  /**
   * @function isEditable
   * @memberof Component.prototype
   * @desc Check if the component is editable and not an occurrence of a recurrent component
   * @returns true or false
   */
  Component.prototype.isEditable = function() {
    return (!this.occurrenceId && !this.isReadOnly);
  };

  /**
   * @function isEditableOccurrence
   * @memberof Component.prototype
   * @desc Check if the component is editable and an occurrence of a recurrent component
   * @returns true or false
   */
  Component.prototype.isEditableOccurrence = function() {
    return (this.occurrenceId && !this.isReadOnly);
  };

  /**
   * @function isInvitation
   * @memberof Component.prototype
   * @desc Check if the component an invitation and not an occurrence of a recurrent component
   * @returns true or false
   */
  Component.prototype.isInvitation = function() {
    return (!this.occurrenceId && this.userHasRSVP);
  };

  /**
   * @function isInvitationOccurrence
   * @memberof Component.prototype
   * @desc Check if the component an invitation and an occurrence of a recurrent component
   * @returns true or false
   */
  Component.prototype.isInvitationOccurrence = function() {
    return (this.occurrenceId && this.userHasRSVP);
  };

  /**
   * @function isReadOnly
   * @memberof Component.prototype
   * @desc Check if the component is not editable and not an invitation
   * @returns true or false
   */
  Component.prototype.isReadOnly = function() {
    return (this.isReadOnly && !this.userHasRSVP);
  };

  /**
   * @function enablePercentComplete
   * @memberof Component.prototype
   * @desc Check if the percent completion should be enabled with respect to the
   *       component's type and status.
   * @returns true if the percent completion should be displayed
   */
  Component.prototype.enablePercentComplete = function() {
    return (this.component = 'vtodo' &&
            this.status != 'not-specified' &&
            this.status != 'cancelled');
  };

  /**
   * @function coversFreeBusy
   * @memberof Component.prototype
   * @desc Check if a specific quarter matches the component's period
   * @returns true if the quarter covers the component's period
   */
  Component.prototype.coversFreeBusy = function(day, hour, quarter) {
    var b = (angular.isDefined(this.freebusy[day]) &&
             angular.isDefined(this.freebusy[day][hour]) &&
             this.freebusy[day][hour][quarter] == 1);
    return b;
  };

  /**
   * @function updateFreeBusyCoverage
   * @memberof Component.prototype
   * @desc Build a 15-minute-based representation of the component's period.
   * @returns an object literal hashed by days and hours and arrays of four 1's and 0's
   */
  Component.prototype.updateFreeBusyCoverage = function() {
    var _this = this, freebusy = {};

    if (this.start && this.end) {
      var roundedStart = new Date(this.start.getTime()),
          roundedEnd = new Date(this.end.getTime()),
          startQuarter = parseInt(roundedStart.getMinutes()/15 + 0.5),
          endQuarter = parseInt(roundedEnd.getMinutes()/15 + 0.5);
      roundedStart.setMinutes(15*startQuarter);
      roundedEnd.setMinutes(15*endQuarter);

      _.each(roundedStart.daysUpTo(roundedEnd), function(date, index) {
        var currentDay = date.getDate(),
            dayKey = date.getDayString(),
            hourKey;
        if (dayKey == _this.start.getDayString()) {
          hourKey = date.getHours().toString();
          freebusy[dayKey] = {};
          freebusy[dayKey][hourKey] = [];
          while (startQuarter > 0) {
            freebusy[dayKey][hourKey].push(0);
            startQuarter--;
          }
        }
        else {
          date = date.beginOfDay();
          freebusy[dayKey] = {};
        }
        while (date.getTime() < _this.end.getTime() &&
               date.getDate() == currentDay) {
          hourKey = date.getHours().toString();
          if (angular.isUndefined(freebusy[dayKey][hourKey]))
            freebusy[dayKey][hourKey] = [];
          freebusy[dayKey][hourKey].push(1);
          date.addMinutes(15);
        }
      });
      return freebusy;
    }
  };

  /**
   * @function updateFreeBusy
   * @memberof Component.prototype
   * @desc Update the freebusy information for the component's period for a specific attendee.
   * @param {Object} card - an Card object instance of the attendee
   */
  Component.prototype.updateFreeBusy = function(attendee) {
    var params, url, days;
    if (attendee.uid) {
      params =
        {
          sday: this.start.getDayString(),
          eday: this.end.getDayString()
        };
      url = ['..', '..', attendee.uid, 'freebusy.ifb'];
      days = _.map(this.start.daysUpTo(this.end), function(day) { return day.getDayString(); });

      if (angular.isUndefined(attendee.freebusy))
        attendee.freebusy = {};

      // Fetch FreeBusy information
      Component.$$resource.fetch(url.join('/'), 'ajaxRead', params).then(function(data) {
        _.each(days, function(day) {
          var hour;

          if (angular.isUndefined(attendee.freebusy[day]))
            attendee.freebusy[day] = {};

          if (angular.isUndefined(data[day]))
            data[day] = {};

          for (var i = 0; i <= 23; i++) {
            hour = i.toString();
            if (data[day][hour])
              attendee.freebusy[day][hour] = [
                data[day][hour]["0"],
                data[day][hour]["15"],
                data[day][hour]["30"],
                data[day][hour]["45"]
              ];
            else
              attendee.freebusy[day][hour] = [0, 0, 0, 0];
          }
        });
      });
    }
  };

  /**
   * @function getClassName
   * @memberof Component.prototype
   * @desc Return the component CSS class name based on its container (calendar) ID.
   * @param {string} [base] - the prefix to add to the class name (defaults to "fg")
   * @returns a string representing the foreground CSS class name
   */
  Component.prototype.getClassName = function(base) {
    if (angular.isUndefined(base))
      base = 'fg';
    return base + '-folder' + (this.destinationCalendar || this.c_folder);
  };

  /**
   * @function addAttendee
   * @memberof Component.prototype
   * @desc Add an attendee and fetch his freebusy info.
   * @param {Object} card - an Card object instance to be added to the attendees list
   */
  Component.prototype.addAttendee = function(card) {
    var attendee, url, params;
    if (card) {
      attendee = {
        name: card.c_cn,
        email: card.$preferredEmail(),
        role: 'req-participant',
        status: 'needs-action',
        uid: card.c_uid
      };
      if (!_.find(this.attendees, function(o) {
        return o.email == attendee.email;
      })) {
        attendee.image = Component.$gravatar(attendee.email, 32);
        if (this.attendees)
          this.attendees.push(attendee);
        else
          this.attendees = [attendee];
        this.updateFreeBusy(attendee);
      }
    }
  };

  /**
   * @function hasAttendee
   * @memberof Component.prototype
   * @desc Verify if one of the email addresses of a Card instance matches an attendee.
   * @param {Object} card - an Card object instance
   * @returns true if the Card matches an attendee
   */
  Component.prototype.hasAttendee = function(card) {
    var attendee = _.find(this.attendees, function(attendee) {
      return _.find(card.emails, function(email) {
        return email.value == attendee.email;
      });
    });
    return angular.isDefined(attendee);
  };

  /**
   * @function canRemindAttendeesByEmail
   * @memberof Component.prototype
   * @desc Verify if the component's reminder must be send by email and if it has at least one attendee.
   * @returns true if attendees can receive a reminder by email
   */
  Component.prototype.canRemindAttendeesByEmail = function() {
    return this.alarm.action == 'email' &&
      !this.isReadOnly &&
      this.attendees && this.attendees.length > 0;
  };

  /**
   * @function addAttachUrl
   * @memberof Component.prototype
   * @desc Add a new attach URL if not already defined
   * @param {string} attachUrl - the URL
   * @returns the number of values in the list of attach URLs
   */
  Component.prototype.addAttachUrl = function(attachUrl) {
    if (angular.isUndefined(this.attachUrls)) {
      this.attachUrls = [{value: attachUrl}];
    }
    else {
      for (var i = 0; i < this.attachUrls.length; i++) {
        if (this.attachUrls[i].value == attachUrl) {
          break;
        }
      }
      if (i == this.attachUrls.length)
        this.attachUrls.push({value: attachUrl});
    }
    return this.attachUrls.length - 1;
  };

  /**
   * @function deleteAttachUrl
   * @memberof Component.prototype
   * @desc Remove an attach URL
   * @param {number} index - the URL index in the list of attach URLs
   */
  Component.prototype.deleteAttachUrl = function(index) {
    if (index > -1 && this.attachUrls.length > index) {
      this.attachUrls.splice(index, 1);
    }
  };

  /**
   * @function $addDueDate
   * @memberof Component.prototype
   * @desc Add a due date
   */
  Component.prototype.$addDueDate = function() {
    this.due = new Date();
    this.dueDate = this.due.toISOString();
  };

  /**
   * @function $deleteDueDate
   * @memberof Component.prototype
   * @desc Delete a due date
   */
  Component.prototype.$deleteDueDate = function() {
    delete this.due;
    delete this.dueDate;
  };

  /**
   * @function $addStartDate
   * @memberof Component.prototype
   * @desc Add a start date
   */
  Component.prototype.$addStartDate = function() {
    this.start = new Date();
  };

  /**
   * @function $deleteStartDate
   * @memberof Component.prototype
   * @desc Delete a start date
   */
  Component.prototype.$deleteStartDate = function() {
    delete this.start;
    delete this.startDate;
  };

  /**
   * @function $reset
   * @memberof Component.prototype
   * @desc Reset the original state the component's data.
   */
  Component.prototype.$reset = function() {
    var _this = this;
    angular.forEach(this, function(value, key) {
      if (key != 'constructor' && key[0] != '$') {
        delete _this[key];
      }
    });
    this.init(this.$shadowData);
    this.$shadowData = this.$omit(true);
  };

  /**
   * @function reply
   * @memberof Component.prototype
   * @desc Reply to an invitation.
   * @returns a promise of the HTTP operation
   */
  Component.prototype.$reply = function() {
    var _this = this, data, path = [this.pid, this.id];

    if (this.occurrenceId)
      path.push(this.occurrenceId);

    data = {
      reply: this.reply,
      delegatedTo: this.delegatedTo,
      alarm: this.$hasAlarm? this.alarm : {}
    };

    return Component.$$resource.save(path.join('/'), data, { action: 'rsvpAppointment' })
      .then(function(data) {
        // Make a copy of the data for an eventual reset
        _this.$shadowData = _this.$omit(true);
        return data;
      });
  };

  /**
   * @function $save
   * @memberof Component.prototype
   * @desc Save the component to the server.
   */
  Component.prototype.$save = function() {
    var _this = this, options, path = [this.pid, this.id];

    if (this.isNew)
      options = { action: 'saveAs' + this.type.capitalize() };

    if (this.occurrenceId)
      path.push(this.occurrenceId);

    return Component.$$resource.save(path.join('/'), this.$omit(), options)
      .then(function(data) {
        // Make a copy of the data for an eventual reset
        _this.$shadowData = _this.$omit(true);
        return data;
      });
  };

  /**
   * @function $unwrap
   * @memberof Component.prototype
   * @desc Unwrap a promise.
   * @param {promise} futureComponentData - a promise of some of the Component's data
   */
  Component.prototype.$unwrap = function(futureComponentData) {
    var _this = this;

    // Expose the promise
    this.$futureComponentData = futureComponentData;

    // Resolve the promise
    this.$futureComponentData.then(function(data) {
      _this.init(data);
      // Make a copy of the data for an eventual reset
      _this.$shadowData = _this.$omit();
    }, function(data) {
      angular.extend(_this, data);
      _this.isError = true;
      Component.$log.error(_this.error);
    });
  };

  /**
   * @function $omit
   * @memberof Component.prototype
   * @desc Return a sanitized object used to send to the server.
   * @return an object literal copy of the Component instance
   */
  Component.prototype.$omit = function() {
    var component = {}, date;
    angular.forEach(this, function(value, key) {
      if (key != 'constructor' && key[0] != '$') {
        component[key] = angular.copy(value);
      }
    });

    // Format dates and times
    component.startDate = component.start ? formatDate(component.start) : '';
    component.startTime = component.start ? formatTime(component.start) : '';
    component.endDate = component.end ? formatDate(component.end) : '';
    component.endTime = component.end ? formatTime(component.end) : '';
    component.dueDate = component.due ? formatDate(component.due) : '';
    component.dueTime = component.due ? formatTime(component.due) : '';

    // Update recurrence definition depending on selections
    if (this.$hasCustomRepeat) {
      if (this.repeat.frequency == 'monthly' && this.repeat.month.type && this.repeat.month.type == 'byday' ||
          this.repeat.frequency == 'yearly' && this.repeat.year.byday) {
        // BYDAY mask for a monthly or yearly recurrence
        delete component.repeat.monthdays;
        component.repeat.days = [{ day: this.repeat.month.day, occurrence: this.repeat.month.occurrence.toString() }];
      }
      else if (this.repeat.month.type) {
        // montly recurrence by month days or yearly by month
        delete component.repeat.days;
      }
    }
    else if (this.repeat.frequency) {
      component.repeat = { frequency: this.repeat.frequency };
    }
    if (this.repeat.frequency) {
      if (this.repeat.end == 'until' && this.repeat.until)
        component.repeat.until = this.repeat.until.stringWithSeparator('-');
      else if (this.repeat.end == 'count' && this.repeat.count)
        component.repeat.count = this.repeat.count;
      else {
        delete component.repeat.until;
        delete component.repeat.count;
      }
    }
    else {
      delete component.repeat;
    }

    if (this.$hasAlarm) {
      if (this.alarm.action && this.alarm.action == 'email' &&
          !(this.attendees && this.attendees.length > 0)) {
        // No attendees; email reminder must be sent to organizer only
        this.alarm.attendees = 0;
        this.alarm.organizer = 1;
      }
    }
    else {
      component.alarm = {};
    }

    function formatTime(date) {
      var hours = date.getHours();
      if (hours < 10) hours = '0' + hours;

      var minutes = date.getMinutes();
      if (minutes < 10) minutes = '0' + minutes;
      return hours + ':' + minutes;
    }

    function formatDate(date) {
      var year = date.getYear();
      if (year < 1000) year += 1900;

      var month = '' + (date.getMonth() + 1);
      if (month.length == 1)
        month = '0' + month;

      var day = '' + date.getDate();
      if (day.length == 1)
        day = '0' + day;

      return year + '-' + month + '-' + day;
    }

    return component;
  };

})();
