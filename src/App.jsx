import { onAuthStateChanged, signInAnonymously, signInWithCustomToken, signOut } from 'firebase/auth';
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { app, appId, auth, db, initialAuthToken } from './firebase/config';

// The number of courts available per time slot
const COURT_COUNT = 2;
// Use BASE_URL for GitHub Pages compatibility - automatically adjusts for base path
const LOGO_URL = `${import.meta.env.BASE_URL}mpc_logo.png`;

// --- Special Slot Configuration ---
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SPECIAL_SLOTS = [
    // First Come First Serve Hours: Tuesday, Thursday (12:00 PM - 4:00 PM)
    { 
        status: 'FCFS', 
        message: 'First Come First Serve Hours',
        days: [2, 4], // Tuesday (2), Thursday (4)
        startHour: 12, startMinute: 0, 
        endHour: 16, endMinute: 0 // Slot starting at 15:30 ends at 16:00
    },
    // Americano Time Slots (Group Play): Wednesday, Friday (9:30 AM - 1:30 PM)
    { 
        status: 'AMERICANO', 
        message: 'Americano Group Play',
        days: [3, 5], // Wednesday (3), Friday (5)
        startHour: 9, startMinute: 30, 
        endHour: 13, endMinute: 30 // Slot starting at 13:00 ends at 13:30
    }
];

// --- Constants for Cost Calculation (New) ---
const COURT_FEE_PER_HOUR = 500; // PHP
const COURT_FEE_PER_SLOT = COURT_FEE_PER_HOUR / 2; // Slots are 30 min (0.5 hour)
const GUEST_FEE_PER_PERSON = 200; // PHP

// Helper function to format date as YYYY-MM-DD
const formatDate = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// Helper function to convert minutes (0-59) to '00' or '30' string
const minutesToTime = (totalMinutes) => {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// Define 30-minute time slots (06:00 to 21:00)
const generateTimeSlots = () => {
    const slots = [];
    const START_MINUTES = 6 * 60; // 6:00 AM
    const END_MINUTES = 21 * 60; // 9:00 PM (Exclusive, last slot ends at 21:00)

    for (let minutes = START_MINUTES; minutes < END_MINUTES; minutes += 30) {
        const start = minutesToTime(minutes);
        const end = minutesToTime(minutes + 30);
        slots.push(`${start} - ${end}`);
    }
    return slots;
};

const TIME_SLOTS = generateTimeSlots();

/**
 * Checks if a specific date and time slot falls under a special, non-bookable status.
 * @param {Date} date - The date being checked.
 * @param {string} timeSlotStart - The start time of the slot (e.g., "12:00").
 * @returns {{status: string, message: string}} The special status or {status: 'BOOKABLE', message: ''}.
 */
const getSpecialSlotStatus = (date, timeSlotStart) => {
    const dayOfWeek = date.getDay(); // 0 (Sun) to 6 (Sat)
    
    // Parse the slot start time
    const [hourStr, minuteStr] = timeSlotStart.split(':');
    const slotHour = parseInt(hourStr, 10);
    const slotMinute = parseInt(minuteStr, 10);

    // Calculate total minutes since midnight for the slot start
    const slotStartInMinutes = slotHour * 60 + slotMinute;

    for (const rule of SPECIAL_SLOTS) {
        if (rule.days.includes(dayOfWeek)) {
            // Calculate total minutes since midnight for rule start/end
            const ruleStartInMinutes = rule.startHour * 60 + rule.startMinute;
            const ruleEndInMinutes = rule.endHour * 60 + rule.endMinute;

            // Check if the slot START time falls within the rule range
            if (slotStartInMinutes >= ruleStartInMinutes && slotStartInMinutes < ruleEndInMinutes) {
                return { status: rule.status, message: rule.message };
            }
        }
    }

    return { status: 'BOOKABLE', message: '' };
};

const App = () => {
    // Firebase states
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // App states
    const [mpcNumber, setMpcNumber] = useState('');
    const [email, setEmail] = useState('');
    const [isMpcNumberSet, setIsMpcNumberSet] = useState(false);
    const [reservations, setReservations] = useState([]);
    const [currentDate, setCurrentDate] = useState(new Date());
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');

    // --- NEW STATES for Multi-Slot Selection and Confirmation ---
    const [selectedSlots, setSelectedSlots] = useState([]); // Array of selected slot objects
    const [confirmationData, setConfirmationData] = useState(null); // Flag/data to open the modal
    const [guestCount, setGuestCount] = useState(0); // Number of guests (0-3)
    const [privacyAgreed, setPrivacyAgreed] = useState(false); // Data privacy checkbox


    // 1. Firebase Initialization and Authentication
    useEffect(() => {
        if (!app || !auth || !db) {
            setMessage("Error: Firebase configuration is missing. Please check your environment variables.");
            setIsAuthReady(true); // Set to true to prevent infinite loading
            return;
        }

        try {
            // setDb(db); // This line was removed as per the new_code, as db is now imported directly.

            const signIn = async () => {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(auth, initialAuthToken);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (e) {
                    console.error("Firebase Sign-In Error:", e);
                }
            };

            const unsubscribe = onAuthStateChanged(auth, (user) => {
                if (user) {
                    setUserId(user.uid);
                }
                setIsAuthReady(true);
            });

            signIn();
            return () => unsubscribe();
        } catch (error) {
            console.error("Firebase Initialization or Auth Error:", error);
            setMessage("Error initializing the reservation system. Check console for details.");
            setIsAuthReady(true);
        }
    }, []);

    // 2. Fetching MPC Number and Email from local storage
    useEffect(() => {
        const storedMpcNumber = localStorage.getItem('mpcNumber');
        const storedEmail = localStorage.getItem('email');
        
        // We only proceed if BOTH MPC number and Email are set
        if (storedMpcNumber && storedEmail) {
            setMpcNumber(storedMpcNumber);
            setEmail(storedEmail);
            setIsMpcNumberSet(true);
        } else if (storedMpcNumber) {
            // If only MPC is set (from a previous version), pre-fill it
            setMpcNumber(storedMpcNumber);
        }
    }, []);

    // 3. Real-time Reservation Listener
    useEffect(() => {
        if (!isAuthReady || !db || !userId) {
            setLoading(true);
            return;
        }

        // Using Firestore as the real-time, synchronized source of truth
        const collectionPath = `artifacts/${appId}/public/data/padelReservations`;
        const q = collection(db, collectionPath);

        setLoading(false);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const currentReservations = [];
            snapshot.forEach((doc) => {
                currentReservations.push({ id: doc.id, ...doc.data() });
            });
            setReservations(currentReservations);
        }, (error) => {
            console.error("Firestore Snapshot Error:", error);
            setMessage("Error fetching real-time reservations.");
        });

        return () => unsubscribe();
    }, [db, userId, isAuthReady]);

    // 4. Date Navigation Handlers
    const handleDateChange = (days) => {
        const newDate = new Date(currentDate);
        newDate.setDate(currentDate.getDate() + days);
        
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const newDateStart = new Date(newDate);
        newDateStart.setHours(0, 0, 0, 0);

        // Prevent navigating to past days
        if (days < 0 && newDateStart.getTime() < todayStart.getTime()) {
            return;
        }
        
        setCurrentDate(newDate);
        setSelectedSlots([]); // Clear selection on date change
        setMessage('');
    };

    // Helper for basic email validation
    const isValidEmail = (input) => {
        return /\S+@\S+\.\S+/.test(input);
    };

    const handleMpcNumberSubmit = (e) => {
        e.preventDefault();
        const trimmedMpc = mpcNumber.trim();
        const trimmedEmail = email.trim();

        if (!trimmedMpc) {
            setMessage('Please enter your MPC Number.');
            return;
        }
        
        if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
            setMessage('Please enter a valid email address for confirmation.');
            return;
        }

        localStorage.setItem('mpcNumber', trimmedMpc);
        localStorage.setItem('email', trimmedEmail);
        setIsMpcNumberSet(true);
        setMessage(''); // Clear any previous error message
    };

    // 5. Multi-Slot Selection Logic
    const handleSlotSelection = useCallback((slot) => {
        // Pre-checks (Disabling non-bookable slots in the render handles most of this)
        if (slot.isDisabled || slot.isFullyBooked || slot.isSpecialSlot) {
            return;
        }

        const slotTimeIndex = TIME_SLOTS.indexOf(slot.time);
        const isSelected = selectedSlots.some(s => s.id === slot.id);

        if (isSelected) {
            // CASE 1: Deselect/Shorten the selected block
            // Find the index of the clicked slot in the currently selected array
            const selectedIndex = selectedSlots.findIndex(s => s.id === slot.id);
            
            // New logic: Clicking a selected slot shortens the block to all slots *before* the clicked one.
            const newSelectedSlots = selectedSlots.slice(0, selectedIndex);
            
            setSelectedSlots(newSelectedSlots);
            
            if (newSelectedSlots.length === 0) {
                setMessage('Selection cleared.');
            } else {
                 // Get the start time of the new, shortened block
                const startTime = newSelectedSlots[0].time.split(' - ')[0];
                setMessage(`Reservation block adjusted to ${newSelectedSlots.length * 30} minutes. Selection starts at ${startTime}.`);
            }
            
        } else {
            // CASE 2: Select/Extend the block
            
            if (selectedSlots.length >= 4) {
                setMessage('Maximum of 4 adjacent slots (2 hours) can be selected.');
                return;
            }
            
            if (slot.isUserBooking) {
                 setMessage('You already have a reservation in this block. Please cancel the existing reservation first if you wish to re-book.');
                 return;
            }

            if (selectedSlots.length === 0) {
                // First slot selection
                setSelectedSlots([slot]);
                setMessage('Slot selected. Select an adjacent slot to extend (max 4).');
            } else {
                // Subsequent slot selection: Must be adjacent to the start or the end
                
                const firstSelectedSlot = selectedSlots[0];
                const lastSelectedSlot = selectedSlots[selectedSlots.length - 1];
                
                const firstTimeIndex = TIME_SLOTS.indexOf(firstSelectedSlot.time);
                const lastTimeIndex = TIME_SLOTS.indexOf(lastSelectedSlot.time);
                
                // Check if the new slot is contiguous to the start (before it)
                const isAdjacentBefore = slotTimeIndex === firstTimeIndex - 1;
                // Check if the new slot is contiguous to the end (after it)
                const isAdjacentAfter = slotTimeIndex === lastTimeIndex + 1;
                
                if (isAdjacentBefore || isAdjacentAfter) {
                    // Add the new slot and sort to keep chronological order
                    const newSlots = [...selectedSlots, slot].sort((a, b) => 
                        TIME_SLOTS.indexOf(a.time) - TIME_SLOTS.indexOf(b.time)
                    );

                    if (newSlots.length > 4) {
                        setMessage('Maximum of 4 adjacent slots (2 hours) can be selected.');
                        return; // Should not happen if length check is correct, but good guard
                    }
                    
                    setSelectedSlots(newSlots);
                    setMessage(`Extended selection to ${newSlots.length} slots. Total time: ${newSlots.length * 30} minutes.`);
                } else {
                    setMessage('Slots must be immediately adjacent to the start or end of the current selection to form a contiguous block.');
                }
            }
        }
    }, [selectedSlots, userId]);

    // 6. Function to open the Confirmation Modal
    const openConfirmationModal = () => {
        if (selectedSlots.length === 0) {
            setMessage('Please select at least one time slot to proceed.');
            return;
        }
        if (!mpcNumber || !email || !userId) {
            setMessage('Authentication is not complete. Please refresh and ensure your MPC number and Email are entered.');
            return;
        }
        
        // Define the time range for display
        const startTime = selectedSlots[0].time.split(' - ')[0];
        const endTime = selectedSlots[selectedSlots.length - 1].time.split(' - ')[1];

        setConfirmationData({
            timeRange: `${startTime} - ${endTime}`,
            totalSlots: selectedSlots.length,
            // Keep guest count and privacy agreed state managed by the modal itself.
        });

        // Reset modal specific states before opening
        setGuestCount(0);
        setPrivacyAgreed(false);
        setMessage('');
    };

    // 7. Final Booking Logic (handles multiple slots)
    const handleFinalBooking = async () => {
        if (!confirmationData || !privacyAgreed || !db || selectedSlots.length === 0) return;

        // Store data needed for success message before closing modal
        const timeRange = confirmationData.timeRange;
        
        // Close modal immediately when confirm is clicked
        setConfirmationData(null);

        // --- COST CALCULATION ---
        const calculatedCourtFee = selectedSlots.length * COURT_FEE_PER_SLOT;
        const calculatedGuestFee = guestCount * GUEST_FEE_PER_PERSON;
        const estimatedCost = calculatedCourtFee + calculatedGuestFee;

        // Determine which court is available across *all* selected slots
        const dateString = formatDate(currentDate);
        
        let courtToReserve = null;
        
        // Check Court 1 availability across all selected slots
        const isCourt1Available = selectedSlots.every(slot => {
            const reservationsForTime = reservations.filter(r => r.date === dateString && r.timeSlot === slot.time);
            const bookedCourts = reservationsForTime.map(r => r.court);
            return !bookedCourts.includes('Court 1');
        });

        if (isCourt1Available) {
            courtToReserve = 'Court 1';
        } else {
             // Check Court 2 availability across all selected slots
            const isCourt2Available = selectedSlots.every(slot => {
                const reservationsForTime = reservations.filter(r => r.date === dateString && r.timeSlot === slot.time);
                const bookedCourts = reservationsForTime.map(r => r.court);
                return !bookedCourts.includes('Court 2');
            });

            if (isCourt2Available) {
                courtToReserve = 'Court 2';
            }
        }

        if (!courtToReserve) {
            setMessage('A court became fully booked during your selection. Please re-select your desired time block.');
            setSelectedSlots([]);
            return;
        }
        
        const bookingPromises = selectedSlots.map(slot => {
            // Firestore Doc ID must be unique per court AND per time slot
            const reservationRef = doc(db, 
                `artifacts/${appId}/public/data/padelReservations`, 
                `${dateString}-${slot.id}-${courtToReserve.replace(/\s/g, '')}`
            );

            return setDoc(reservationRef, {
                date: dateString,
                timeSlot: slot.time,
                userId: userId,
                mpcNumber: mpcNumber.trim(),
                email: email.trim(),
                timestamp: new Date().toISOString(),
                court: courtToReserve,
                // --- NEW SCHEMA FIELDS (only store these on one doc, but for simplicity, storing on all) ---
                guestCount: guestCount, 
                estimatedCost: estimatedCost / selectedSlots.length, // Cost per slot
                blockId: Date.now() // Unique ID for the block reservation
            });
        });

        try {
            await Promise.all(bookingPromises);
            setMessage(`Successfully reserved ${timeRange} on ${courtToReserve}! Total estimated cost: PHP ${estimatedCost.toFixed(2)}.`);
            setSelectedSlots([]); // Clear selection
        } catch (error) {
            console.error("Error reserving slot block:", error);
            setMessage("Failed to make reservation. Check console for details.");
        }
    };


    const handleCancel = async (reservationId) => {
        if (!userId || !db) return;

        const reservationRef = doc(db, `artifacts/${appId}/public/data/padelReservations`, reservationId);

        try {
            await deleteDoc(reservationRef);
            setMessage('Reservation cancelled successfully.');
        } catch (error) {
            console.error("Error cancelling slot:", error);
            setMessage("Failed to cancel reservation. Check console for details.");
        }
    };

    const handleSignOut = async () => {
        try {
            // Sign out from Firebase
            if (auth) {
                await signOut(auth);
            }
            
            // Clear local storage
            localStorage.removeItem('mpcNumber');
            localStorage.removeItem('email');
            
            // Reset app state
            setMpcNumber('');
            setEmail('');
            setIsMpcNumberSet(false);
            setSelectedSlots([]);
            setConfirmationData(null);
            setMessage('You have been signed out successfully.');
            
            // The component will re-render and show the login form
        } catch (error) {
            console.error("Sign out error:", error);
            setMessage("Error signing out. Please try again.");
        }
    };

    // 8. Memoized Computed Data (Slots)
    const slots = useMemo(() => {
        const dateString = formatDate(currentDate);
        const bookedSlotGroups = reservations
            .filter(r => r.date === dateString)
            .reduce((acc, r) => {
                if (!acc[r.timeSlot]) {
                    acc[r.timeSlot] = [];
                }
                acc[r.timeSlot].push(r);
                return acc;
            }, {});

        // Determine if current day is in the past (to disable past slots)
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const currentDateStart = new Date(currentDate);
        currentDateStart.setHours(0, 0, 0, 0);
        const isPastDay = currentDateStart.getTime() < todayStart.getTime();

        return TIME_SLOTS.map((time) => {
            const reservationsForTime = bookedSlotGroups[time] || [];
            const bookedCount = reservationsForTime.length;
            const availableCourts = COURT_COUNT - bookedCount;
            const isFullyBooked = bookedCount >= COURT_COUNT;
            
            // Find ALL user reservations for this time slot (could be one on Court 1 and one on Court 2)
            const userReservations = reservationsForTime.filter(r => r.userId === userId);
            
            const timeParts = time.split(' - ');
            const timeSlotStart = timeParts[0];

            // Check for special status (FCFS/AMERICANO)
            const specialStatus = getSpecialSlotStatus(currentDate, timeSlotStart);

            // Check if the slot is in the past for the current day
            const now = new Date();
            const slotStart = new Date(currentDateStart.getTime());
            const [hour, minute] = timeSlotStart.split(':').map(Number);
            slotStart.setHours(hour, minute, 0, 0);
            
            const isSlotInPast = !isPastDay && (slotStart.getTime() < now.getTime());

            const isSpecialSlot = specialStatus.status !== 'BOOKABLE';
            const isSelected = selectedSlots.some(s => s.time === time);

            return {
                time,
                // ID for Firestore path segment (e.g., "06:00 - 06:30" -> "06-00--06-30")
                id: time.replace(/:/g, '-').replace(/\s/g, ''),
                bookedCount,
                availableCourts,
                isFullyBooked,
                userReservations, // Array of user's bookings for this slot (max 2)
                isUserBooking: userReservations.length > 0,
                specialStatus: specialStatus,
                isSpecialSlot: isSpecialSlot, // Export flag for easy checking
                isSelected: isSelected, // New flag
                // Disable if past, or if it falls under a non-bookable special rule
                isDisabled: isPastDay || isSlotInPast || isSpecialSlot
            };
        });
    }, [reservations, currentDate, userId, selectedSlots]); // Added selectedSlots to dependencies

    // Confirmation Modal Component (Inline for simplicity)
    const ConfirmationModal = () => {
        if (!confirmationData) return null;

        const dateString = new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
        
        // Cost calculation for display
        const totalCourtFee = confirmationData.totalSlots * COURT_FEE_PER_SLOT;
        const guestFee = guestCount * GUEST_FEE_PER_PERSON;
        const totalEstimatedCost = totalCourtFee + guestFee;
        
        const guestOptions = [0, 1, 2, 3];
        const durationHours = confirmationData.totalSlots / 2;

        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
                <div className="bg-[#001a35] text-white p-6 rounded-xl shadow-2xl w-full max-w-lg border-2 border-[#d4af37] transform transition-all duration-300 scale-100">
                    <h2 className="text-2xl font-bold mb-4 text-[#d4af37]">Confirm Your Block Reservation</h2>
                    
                    <div className="space-y-3 mb-6 p-4 bg-[#0e1f37] rounded-lg">
                        <p className="font-semibold text-lg">
                            Time Block: <span className="text-white">{confirmationData.timeRange}</span>
                        </p>
                        <p className="text-gray-300">
                            Date: <span className="text-white">{dateString}</span>
                        </p>
                         <p className="text-gray-300">
                            Duration: <span className="text-white">{durationHours} hour{durationHours !== 1 ? 's' : ''} ({confirmationData.totalSlots} slots)</span>
                        </p>
                        <p className="text-gray-300">
                            Booker: <span className="text-white">{mpcNumber}</span>
                        </p>
                    </div>

                    {/* Guest Selector */}
                    <div className="mb-6">
                        <label htmlFor="guest-select" className="block text-lg font-medium mb-2 text-white">
                            Number of Guests (0-3):
                        </label>
                        <select
                            id="guest-select"
                            value={guestCount}
                            onChange={(e) => setGuestCount(Number(e.target.value))}
                            className="w-full px-4 py-3 rounded-lg border-2 border-[#d4af37] bg-[#0e1f37] text-white focus:outline-none focus:ring-2 focus:ring-[#d4af37]"
                        >
                            {guestOptions.map(num => (
                                <option key={num} value={num}>{num} Guest{num !== 1 ? 's' : ''}</option>
                            ))}
                        </select>
                    </div>

                    {/* Estimated Cost Breakdown */}
                    <div className="mb-6 p-4 bg-yellow-900/30 rounded-lg border border-yellow-700">
                        <h3 className="text-xl font-bold text-[#d4af37] mb-2">Estimated Cost</h3>
                        <div className="flex justify-between text-gray-300">
                            <span>Court Rental ({durationHours} hr @ PHP {COURT_FEE_PER_HOUR}/hr)</span>
                            <span>PHP {totalCourtFee.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-gray-300">
                            <span>Guest Fees ({guestCount} x PHP {GUEST_FEE_PER_PERSON})</span>
                            <span>+ PHP {guestFee.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-lg font-bold mt-2 text-white border-t border-yellow-700 pt-2">
                            <span>Total Estimated Cost</span>
                            <span>PHP {totalEstimatedCost.toFixed(2)}</span>
                        </div>
                    </div>


                    {/* Data Privacy Checklist (from image) */}
                    <div className="mb-6 p-4 border-2 border-red-500 rounded-lg bg-red-900/30">
                        <p className="text-sm font-medium text-red-300 mb-3">
                            By sending this form you agree to the processing of the personal data and understood the Manila Polo privacy policy <a href="https://www.manilapolo.com.ph/privacy" target="_blank" rel="noopener noreferrer" className="text-red-300 underline hover:text-red-100">https://www.manilapolo.com.ph/privacy</a>. <span className="text-red-300">*</span>
                        </p>
                        <label className="flex items-center space-x-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={privacyAgreed}
                                onChange={() => setPrivacyAgreed(!privacyAgreed)}
                                className="form-checkbox h-5 w-5 text-red-600 rounded border-red-500 focus:ring-red-500"
                            />
                            <span className="text-white font-semibold">I Agree</span>
                        </label>
                    </div>


                    {/* Action Buttons */}
                    <div className="flex justify-end space-x-4">
                        <button
                            onClick={() => setConfirmationData(null)}
                            className="px-6 py-2 border border-gray-600 text-gray-300 rounded-lg hover:bg-gray-700 transition duration-150"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleFinalBooking}
                            disabled={!privacyAgreed}
                            className="px-6 py-2 bg-[#d4af37] text-[#001a35] font-bold rounded-lg disabled:opacity-50 hover:bg-yellow-400 transition duration-300 shadow-md"
                        >
                            Confirm Booking ({confirmationData.totalSlots} Slots)
                        </button>
                    </div>
                </div>
            </div>
        );
    };


    // 9. Component Render Logic
    if (!isMpcNumberSet) {
        return (
            <div className="min-h-screen flex items-center justify-center p-4 bg-[#0e1f37] font-sans">
                <div className="bg-[#001a35] text-white p-8 rounded-xl shadow-2xl w-full max-w-md">
                    {/* Image tag using the corrected LOGO_URL */}
                    <div className="h-20 w-full mb-4 flex justify-center">
                        <img 
                            src={LOGO_URL} 
                            alt="Manila Polo Club Logo" 
                            className="mx-auto h-20 w-auto object-contain"
                            // FIX: Removed console.error to stop repeated console messages
                            onError={(e) => { e.target.style.display = 'none'; }} 
                        />
                    </div>
                    
                    <h1 className="text-3xl font-bold mb-6 text-[#d4af37] text-center">
                        Manila Polo Club Padel
                    </h1>
                    
                    {message && (
                        <div className="bg-red-700 text-white font-semibold p-3 rounded-lg mb-4 text-center shadow-md">
                            {message}
                        </div>
                    )}

                    <p className="text-center mb-6">
                        Please enter your MPC Number and Email address to proceed with booking.
                    </p>
                    <form onSubmit={handleMpcNumberSubmit} className="space-y-4">
                        <input
                            type="text"
                            value={mpcNumber}
                            onChange={(e) => setMpcNumber(e.target.value)}
                            placeholder="Enter MPC Number (e.g., 12345)"
                            className="w-full px-4 py-3 rounded-lg border-2 border-[#d4af37] bg-[#0e1f37] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#d4af37]"
                            required
                        />
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Enter Valid Email Address (for confirmation)"
                            className="w-full px-4 py-3 rounded-lg border-2 border-[#d4af37] bg-[#0e1f37] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#d4af37]"
                            required
                        />
                        <button
                            type="submit"
                            className="w-full bg-[#d4af37] text-[#001a35] font-bold py-3 rounded-lg hover:bg-yellow-400 transition duration-300 shadow-md"
                        >
                            Enter Club
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    if (loading || !isAuthReady) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#0e1f37] text-[#d4af37] font-sans">
                <p className="text-xl">Loading Reservation System...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen p-4 sm:p-8 bg-[#0e1f37] font-sans">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <header className="text-center py-6 bg-[#001a35] rounded-t-xl shadow-lg">
                    {/* Image tag using the corrected LOGO_URL */}
                    <div className="h-20 w-full mb-3 flex justify-center">
                        <img 
                            src={LOGO_URL} 
                            alt="Manila Polo Club Logo" 
                            className="mx-auto h-20 w-auto object-contain"
                            // FIX: Removed console.error to stop repeated console messages
                            onError={(e) => { e.target.style.display = 'none'; }}
                        />
                    </div>
                    
                    <h1 className="text-3xl sm:text-4xl font-extrabold text-[#d4af37] tracking-wider">
                        MPC Padel Court Booking ({COURT_COUNT} Courts)
                    </h1>
                    <p className="text-gray-300 text-sm mt-1">
                        Welcome, Member {mpcNumber} (<span className="text-[#d4af37]">{email}</span>)
                    </p>
                </header>

                {/* Message Box */}
                {message && (
                    <div className="bg-[#d4af37] text-[#001a35] font-semibold p-3 rounded-lg my-4 text-center shadow-md">
                        {message}
                    </div>
                )}

                {/* Date Navigation */}
                <div className="flex justify-between items-center bg-[#001a35] p-4 rounded-xl my-6 shadow-md">
                    <button
                        onClick={() => handleDateChange(-1)}
                        className="bg-[#d4af37] text-[#001a35] p-2 rounded-full disabled:opacity-50 transition duration-150 hover:scale-105"
                        disabled={new Date(currentDate).setHours(0, 0, 0, 0) <= new Date().setHours(0, 0, 0, 0)}
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <h2 className="text-xl sm:text-2xl font-bold text-white">
                        {new Date(currentDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                    </h2>
                    <button
                        onClick={() => handleDateChange(1)}
                        className="bg-[#d4af37] text-[#001a35] p-2 rounded-full transition duration-150 hover:scale-105"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                    </button>
                </div>
                
                {/* Main Action Button */}
                <div className="mb-6 flex justify-center">
                    <button
                        onClick={openConfirmationModal}
                        disabled={selectedSlots.length === 0}
                        className="w-full sm:w-auto px-10 py-3 bg-green-600 text-white font-bold rounded-lg disabled:opacity-50 hover:bg-green-700 transition duration-300 shadow-xl shadow-green-900/50"
                    >
                        {selectedSlots.length > 0 ? 
                            `Proceed to Booking (${selectedSlots.length * 30} min)` : 
                            'Select Time Slots (Max 4)'
                        }
                    </button>
                </div>


                {/* Reservation Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {slots.map((slot) => {
                        const isSpecial = slot.isSpecialSlot;
                        
                        let bgColor = 'bg-[#001a35] hover:bg-[#d4af37]/20 cursor-pointer'; // Default bookable
                        let borderColor = 'border-[#d4af37]/50';

                        if (slot.isDisabled) {
                            bgColor = 'bg-gray-800 opacity-60 pointer-events-none';
                        } else if (isSpecial) {
                            bgColor = 'bg-purple-900 border-2 border-purple-500 opacity-90 pointer-events-none'; 
                        } else if (slot.isFullyBooked) {
                            bgColor = 'bg-red-900 border-2 border-red-500 opacity-90 pointer-events-none';
                        } else if (slot.isUserBooking) {
                             bgColor = 'bg-indigo-700 border-2 border-indigo-400 hover:bg-indigo-800'; // Make user-booked slots hoverable
                        } else if (slot.isSelected) {
                            // Selected state overrides general colors
                            bgColor = 'bg-green-700 border-2 border-green-400 hover:bg-green-800';
                            borderColor = 'border-green-400';
                        }
                        
                        // A slot is clickable if it is NOT disabled, special, or fully booked
                        const isBookableClickable = !slot.isDisabled && !isSpecial && !slot.isFullyBooked;
                        
                        return (
                            <div 
                                key={slot.time} 
                                className={`p-5 rounded-xl shadow-lg transition duration-300 border-2 ${bgColor} ${borderColor} ${isBookableClickable || slot.isUserBooking ? 'cursor-pointer' : 'cursor-default'}`}
                                // Handle slot selection/deselection only if it's a bookable slot
                                onClick={() => isBookableClickable && handleSlotSelection(slot)}
                            >
                                <div className="flex justify-between items-center mb-2">
                                    <h3 className={`text-xl font-semibold ${isSpecial ? 'text-purple-300' : slot.isDisabled ? 'text-gray-400' : 'text-white'}`}>
                                        {slot.time}
                                    </h3>
                                    
                                    {slot.isDisabled ? (
                                        isSpecial ? (
                                            <span className="text-purple-300 px-3 py-1 rounded-full text-sm font-medium border border-purple-500">
                                                {slot.specialStatus.status}
                                            </span>
                                        ) : (
                                            <span className="text-gray-500 px-3 py-1 rounded-full text-sm font-medium border border-gray-700">
                                                Expired
                                            </span>
                                        )
                                    ) : slot.isFullyBooked ? (
                                        <span className="text-red-300 px-3 py-1 rounded-full text-sm font-medium border border-red-500">
                                            Fully Booked
                                        </span>
                                    ) : slot.isSelected ? (
                                        <span className="bg-green-400 text-green-900 px-3 py-1 rounded-full font-bold text-sm">
                                            Selected
                                        </span>
                                    ) : (
                                        <span className="text-[#d4af37] px-3 py-1 rounded-full text-sm font-medium border border-[#d4af37]">
                                            Available
                                        </span>
                                    )}
                                </div>
                                
                                {/* Status and User Bookings */}
                                <div className="text-sm">
                                    {isSpecial ? (
                                        <p className="font-medium text-purple-300">
                                            {slot.specialStatus.message} - Not bookable online.
                                        </p>
                                    ) : slot.isDisabled ? (
                                        <p className="text-gray-500">This time slot is in the past.</p>
                                    ) : (
                                        <p className={`font-medium ${slot.isFullyBooked ? 'text-red-300' : 'text-green-400'}`}>
                                            {slot.availableCourts} / {COURT_COUNT} courts available
                                        </p>
                                    )}

                                    {/* Display User's specific bookings for easy cancellation */}
                                    {/* These are clickable even if the slot is otherwise not bookable for selection (e.g. past, but not special) */}
                                    {slot.userReservations.map(res => (
                                        <div 
                                            key={res.id} 
                                            className="mt-2 flex justify-between items-center p-2 bg-black/30 rounded-lg"
                                        >
                                            <span className="text-sm font-semibold text-white">
                                                {res.court} (Yours)
                                            </span>
                                            <button
                                                // CRITICAL: Stop propagation so clicking the cancel button doesn't trigger slot selection/deselection logic
                                                onClick={(e) => {
                                                    e.stopPropagation(); 
                                                    handleCancel(res.id);
                                                }}
                                                className="bg-red-500 text-white px-2 py-1 rounded-full text-xs hover:bg-red-600 transition duration-150"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ))}

                                    {/* Display Other Bookings (if not fully booked by user) */}
                                    {slot.bookedCount > 0 && !isSpecial && (
                                        <p className="text-gray-400 mt-1">
                                            {slot.bookedCount - slot.userReservations.length} booked by other members.
                                        </p>
                                    )}
                                </div>

                            </div>
                        );
                    })}
                </div>

                {/* Confirmation Modal Render */}
                <ConfirmationModal />
                
                {/* Footer and Info */}
                <footer className="text-center mt-10 pt-4 border-t border-gray-700">
                    <button
                        onClick={handleSignOut}
                        className="mb-4 px-6 py-2 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition duration-300 shadow-md"
                    >
                        Sign Out
                    </button>
                    <p className="text-gray-500 text-xs mt-4">
                        MPC User ID (for Admin use only): <span className="text-gray-400 break-all">{userId}</span>
                    </p>
                </footer>
            </div>
        </div>
    );
};

export default App;